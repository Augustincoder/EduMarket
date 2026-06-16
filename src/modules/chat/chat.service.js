const prisma = require('../../config/prisma');
const { AppError } = require('../../middleware/errorHandler');
const { getIO, getOnlineUsersSet } = require('../../config/socket');
const logger = require('../../utils/logger');
const { chatQueue } = require('../../config/queue');

/**
 * 3-BOSQICH: XABARLASHISH VA TIZIM VOQEALARI (MESSAGING & EVENTS)
 */

async function checkChatAccess(chatRoomId, userId) {
  const participant = await prisma.chatParticipant.findUnique({
    where: { chatRoomId_userId: { chatRoomId, userId } },
    include: { chatRoom: true }
  });

  if (!participant) {
    throw new AppError('Ushbu chatga kirish huquqingiz yo\'q', 403);
  }

  return { room: participant.chatRoom, participant };
}

// Xabar yuborish (Matn yoki Fayl)
async function sendMessage(chatRoomId, senderId, data) {
  const { room, participant } = await checkChatAccess(chatRoomId, senderId);

  // 1. Check if room is archived
  if (room.isArchived) throw new AppError('Ushbu chat arxivlangan, xabar yuborib bo\'lmaydi', 403);

  // 2. Check if user is muted
  if (participant.mutedUntil && new Date(participant.mutedUntil) > new Date()) {
    throw new AppError('Siz yozishdan cheklangansiz', 403);
  }

  // 3. Check Slow-mode
  const settings = (room.settings && typeof room.settings === 'object') ? room.settings : {};
  if (settings.slowModeSeconds && participant.role === 'MEMBER') {
    const lastMessage = await prisma.chatMessage.findFirst({
      where: { chatRoomId, senderId },
      orderBy: { createdAt: 'desc' }
    });

    if (lastMessage) {
      const diffSeconds = (new Date() - new Date(lastMessage.createdAt)) / 1000;
      if (diffSeconds < settings.slowModeSeconds) {
        throw new AppError(`Iltimos, navbatdagi xabar uchun ${Math.ceil(settings.slowModeSeconds - diffSeconds)} soniya kuting (Slow-mode)`, 429);
      }
    }
  }

  // Fetch replyTo if exists
  if (data.replyToId) {
    const _replyTo = await prisma.chatMessage.findUnique({
      where: { id: data.replyToId },
      select: { id: true, chatRoomId: true, content: true, fileType: true, sender: { select: { fullname: true } } }
    });

    if (!_replyTo || _replyTo.chatRoomId !== chatRoomId) {
      data.replyToId = null;
    }
  }

  // 1. Save to DB Synchronously (Outbox Pattern)
  const message = await prisma.chatMessage.create({
    data: {
      chatRoomId,
      senderId,
      type: data.type || 'TEXT',
      content: data.content,
      fileId: data.fileId,
      fileType: data.fileType,
      fileName: data.fileName,
      isSecureFile: data.isSecureFile || false,
      replyToId: data.replyToId,
      metadata: data.metadata || null,
    },
    include: {
      sender: { select: { id: true, fullname: true, username: true, avatarUrl: true } },
      reactions: { select: { icon: true, userId: true } },
      replyTo: {
        select: { id: true, content: true, fileType: true, sender: { select: { fullname: true } } }
      }
    }
  });

  // Fetch participants once to avoid double DB queries
  let participants = [];
  try {
    participants = await prisma.chatParticipant.findMany({
      where: { chatRoomId },
      select: { userId: true }
    });
  } catch (err) {
    logger.error(`Failed to fetch participants: ${err.message}`);
  }

  // 2. Attach clientId to help frontend deduplicate optimistic messages
  if (data.clientId) {
    message.clientId = data.clientId;
  }

  // 3. Emit to Socket immediately for real-time feel
  try {
    const io = getIO();
    const roomName = `chat_${chatRoomId}`;
    
    // Emit to the room for those who are actively looking at it
    io.to(roomName).emit('new_message', message);
    
    // Emit to each participant's personal room for sidebar/notification updates
    participants.forEach(p => {
      io.to(`user_${p.userId}`).emit('new_message', message);
    });

  } catch (err) {
    logger.error(`Socket emit failed: ${err.message}`);
  }

  // 4. Add side-effects to BullMQ (Offline Notifications, analytics, etc)
  try {
    await chatQueue.add('process_message_side_effects', {
      messageId: message.id,
      participants,
      chatRoomId,
      senderId,
      senderName: message.sender?.fullname || 'Foydalanuvchi'
    });
  } catch (err) {
    logger.error(`Failed to add message side-effects to Queue: ${err.message}`);
  }

  return message;
}

// Tizim xabari (System Event) yuborish (Bot kabi)
async function sendSystemEvent(chatRoomId, content, metadata = null) {
  // 1. Save to DB
  const message = await prisma.chatMessage.create({
    data: {
      chatRoomId,
      senderId: null, // Tizim xabari
      type: 'SYSTEM_EVENT',
      content,
      metadata
    }
  });

  // 2. Fetch participants to ensure global delivery
  let participants = [];
  try {
    participants = await prisma.chatParticipant.findMany({
      where: { chatRoomId },
      select: { userId: true }
    });
  } catch (err) {
    logger.error(`Failed to fetch participants for system event: ${err.message}`);
  }

  // 3. Emit to Socket
  try {
    const io = getIO();
    const roomName = `chat_${chatRoomId}`;
    
    // Emit to active chat room
    io.to(roomName).emit('new_message', message);
    
    // Emit to personal rooms for background/sidebar updates
    participants.forEach(p => {
      io.to(`user_${p.userId}`).emit('new_message', message);
    });
  } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }

  // System events usually don't need offline push notifications
  return message;
}

// Xabarlarni qadab qo'yish (Pin) yoki Olib tashlash (Unpin)
async function pinMessage(chatRoomId, requesterId, messageId) {
  const participant = await prisma.chatParticipant.findUnique({
    where: { chatRoomId_userId: { chatRoomId, userId: requesterId } }
  });

  if (!participant || (participant.role !== 'OWNER' && participant.role !== 'ADMIN')) {
    throw new AppError('Xabarni qadash huquqingiz yo\'q', 403);
  }

  let finalMessageId = messageId;
  let eventText = `Xabar qadab qo'yildi.`;

  if (messageId === 'unpin' || !messageId) {
    finalMessageId = null;
    eventText = `Qadalgan xabar olib tashlandi.`;
  } else {
    const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!message || message.chatRoomId !== chatRoomId) {
      throw new AppError('Xabar ushbu chatga tegishli emas', 404);
    }
  }

  const room = await prisma.chatRoom.update({
    where: { id: chatRoomId },
    data: { pinnedMsgId: finalMessageId },
    include: { pinnedMsg: true }
  });

  try {
    const io = getIO();
    io.to(`chat_${chatRoomId}`).emit('message_pinned', { chatRoomId, message: room.pinnedMsg });
  } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }

  // Tizim xabari ham tashlab qoyamiz
  await sendSystemEvent(chatRoomId, eventText);

  return room;
}

// Composite cursor-based Pagination yordamida xabarlarni yuklash
async function getMessages(chatRoomId, userId, cursor, limit = 50) {
  await checkChatAccess(chatRoomId, userId);

  const where = { chatRoomId };
  
  if (cursor) {
    try {
      // Decode base64 cursor: "timestamp_id"
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
      const [timestamp, cursorId] = decoded.split('_');
      const cursorDate = new Date(timestamp);

      where.OR = [
        { createdAt: { lt: cursorDate } },
        { 
          createdAt: cursorDate,
          id: { lt: cursorId }
        }
      ];
    } catch (e) {
      logger.error(`Invalid cursor format: ${cursor}`);
    }
  }

  const messages = await prisma.chatMessage.findMany({
    where,
    take: limit,
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    include: {
      sender: { select: { id: true, fullname: true, username: true, avatarUrl: true } },
      reactions: { select: { icon: true, userId: true } },
      replyTo: {
        select: { id: true, content: true, fileType: true, sender: { select: { fullname: true } } }
      }
    }
  });

  let nextCursor = null;
  if (messages.length === limit) {
    const lastMsg = messages[messages.length - 1];
    // Encode next cursor as base64: "ISOString_id"
    nextCursor = Buffer.from(`${lastMsg.createdAt.toISOString()}_${lastMsg.id}`).toString('base64');
  }

  // Faqat birinchi sahifada (cursor yo'q) lastReadAt ni yangilaymiz
  // Bu foydalanuvchi tarixni skrol qilayotganda yangi xabarlarni "o'qilgan" deb belgilab qo'ymaslik uchun
  if (!cursor) {
    await prisma.chatParticipant.update({
      where: { chatRoomId_userId: { chatRoomId, userId } },
      data: { lastReadAt: new Date() }
    });
  }

  return { messages, nextCursor };
}

// Barcha chatlar ro'yxati (Sidebar uchun)
async function getConversations(userId) {
  // 1. Fetch all participants and rooms
  const participants = await prisma.chatParticipant.findMany({
    where: { userId },
    include: {
      chatRoom: {
        include: {
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          participants: {
            include: { user: { select: { id: true, fullname: true, username: true, avatarUrl: true } } }
          }
        }
      }
    },
    orderBy: { chatRoom: { updatedAt: 'desc' } }
  });

  if (participants.length === 0) return [];

  // 2. Fetch all unread counts in ONE single raw query (Fixing N+1 issue)
  const unreadCountsRaw = await prisma.$queryRaw`
    SELECT m."chat_room_id" as "chatRoomId", COUNT(m.id)::int as "unreadCount"
    FROM "chat_messages" m
    INNER JOIN "chat_participants" p ON m."chat_room_id" = p."chat_room_id"
    WHERE p."user_id" = ${userId}
      AND m."sender_id" IS DISTINCT FROM ${userId}
      AND m."is_deleted" = false
      AND (p."last_read_at" IS NULL OR m."created_at" > p."last_read_at")
    GROUP BY m."chat_room_id"
  `;

  // Map counts to an object for O(1) lookup
  const unreadCountsMap = {};
  for (const row of unreadCountsRaw) {
    unreadCountsMap[row.chatRoomId] = row.unreadCount;
  }

  // 3. Get online users
  const onlineUsers = await getOnlineUsersSet();

  // 4. Assemble the result
  const result = participants.map((p) => {
    const room = p.chatRoom;
    let title = room.name;
    let avatar = room.avatarUrl;
    let otherUser = null;
    const otherParticipant = room.participants.find(part => part.userId !== userId);

    if (room.type === 'DIRECT') {
      if (otherParticipant) {
        otherUser = otherParticipant.user;
        title = otherUser.fullname;
        avatar = otherUser.avatarUrl;
        otherUser.isOnline = onlineUsers.has(otherUser.id);
      }
    } else if (room.type === 'TASK_ROOM') {
      title = room.name;
      if (otherParticipant) {
        avatar = otherParticipant.user.avatarUrl;
        otherUser = otherParticipant.user;
      }
    }

    return {
      chatRoomId: room.id,
      type: room.type,
      taskId: room.taskId,
      title,
      avatarUrl: avatar,
      otherUser,
      lastMessage: room.messages[0] || null,
      unreadCount: unreadCountsMap[room.id] || 0
    };
  });

  return result;
}

// Xabarni tahrirlash
async function editMessage(messageId, userId, newContent) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('Xabar topilmadi', 404);
  if (message.senderId !== userId) throw new AppError('Faqat o\'zingizning xabaringizni tahrirlashingiz mumkin', 403);
  if (message.isDeleted) throw new AppError('O\'chirilgan xabarni tahrirlab bo\'lmaydi', 400);

  const updatedMessage = await prisma.chatMessage.update({
    where: { id: messageId },
    data: { content: newContent, isEdited: true, editedAt: new Date() },
    include: {
      sender: { select: { id: true, fullname: true, username: true, avatarUrl: true } },
      replyTo: { select: { id: true, content: true, fileType: true, sender: { select: { fullname: true } } } }
    }
  });

  try {
    const io = getIO();
    io.to(`chat_${message.chatRoomId}`).emit('message_edited', updatedMessage);
  } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }

  return updatedMessage;
}

// Xabarni o'chirish
async function deleteMessage(messageId, userId) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('Xabar topilmadi', 404);
  
  // Owner yoki xabar egasi
  const participant = await prisma.chatParticipant.findUnique({
    where: { chatRoomId_userId: { chatRoomId: message.chatRoomId, userId } }
  });

  const isSender = message.senderId === userId;
  const isAdmin = participant?.role === 'OWNER' || participant?.role === 'ADMIN';

  if (!isSender && !isAdmin) {
    throw new AppError('Xabarni o\'chirish huquqingiz yo\'q', 403);
  }

  const deletedMessage = await prisma.chatMessage.update({
    where: { id: messageId },
    data: { isDeleted: true, deletedAt: new Date(), content: null }
  });

  try {
    const io = getIO();
    io.to(`chat_${message.chatRoomId}`).emit('message_deleted', { messageId, chatRoomId: message.chatRoomId });
  } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }

  return deletedMessage;
}

// Reaksiyalar (Like, Heart)
async function toggleReaction(messageId, userId, icon) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) throw new AppError('Xabar topilmadi', 404);
  
  await checkChatAccess(message.chatRoomId, userId);

  const existingReaction = await prisma.messageReaction.findUnique({
    where: { messageId_userId: { messageId, userId } }
  });

  if (existingReaction) {
    if (existingReaction.icon === icon) {
      // O'chirish (Toggle off)
      await prisma.messageReaction.delete({
        where: { id: existingReaction.id }
      });
    } else {
      // Iconni yangilash
      await prisma.messageReaction.update({
        where: { id: existingReaction.id },
        data: { icon }
      });
    }
  } else {
    // Yangi qo'shish
    await prisma.messageReaction.create({
      data: { messageId, userId, icon }
    });
  }

  // Barcha reaksiyalarni qaytadan o'qiymiz
  const allReactions = await prisma.messageReaction.findMany({
    where: { messageId },
    select: { icon: true, userId: true }
  });

  try {
    const io = getIO();
    io.to(`chat_${message.chatRoomId}`).emit('message_reaction_updated', { 
      messageId, 
      chatRoomId: message.chatRoomId, 
      reactions: allReactions 
    });
  } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }

  return { messageId, reactions: allReactions };
}

// Xabarlarni o'qilgan deb belgilash
async function markAsRead(chatRoomId, userId) {
  await checkChatAccess(chatRoomId, userId);
  
  // Find the last message in the room
  const lastMessage = await prisma.chatMessage.findFirst({
    where: { chatRoomId, isDeleted: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true }
  });

  const now = new Date();

  // Update participant's lastReadAt
  await prisma.chatParticipant.update({
    where: { chatRoomId_userId: { chatRoomId, userId } },
    data: { lastReadAt: now }
  });

  // Update or Create Read Receipt
  if (lastMessage) {
    await prisma.messageReadReceipt.upsert({
      where: { chatRoomId_userId: { chatRoomId, userId } },
      update: { lastReadMessageId: lastMessage.id, readAt: now },
      create: { chatRoomId, userId, lastReadMessageId: lastMessage.id, readAt: now }
    });

    // Emit real-time read receipt
    try {
      const io = getIO();
      io.to(`chat_${chatRoomId}`).emit('read_receipt', { 
        chatRoomId, 
        userId, 
        lastReadMessageId: lastMessage.id,
        readAt: now
      });
    } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }
  }

  return { success: true };
}

// Global Full-Text Search (Master Level)
async function searchGlobalMessages(userId, query) {
  if (!query || query.trim().length < 2) return [];

  // Find all rooms the user is part of
  const participants = await prisma.chatParticipant.findMany({
    where: { userId },
    select: { chatRoomId: true }
  });
  
  if (participants.length === 0) return [];
  
  const roomIds = participants.map(p => p.chatRoomId);

  // Sanitize query to keep only letters, numbers and spaces
  const cleanQuery = query.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (cleanQuery.length < 2) return [];

  // PostgreSQL FTS query format: "word1:* | word2:*"
  const formattedQuery = cleanQuery.split(/\s+/).map(word => `${word}:*`).join(' | ');

  const messages = await prisma.chatMessage.findMany({
    where: {
      chatRoomId: { in: roomIds },
      content: {
        search: formattedQuery
      },
      isDeleted: false
    },
    take: 50,
    orderBy: { _relevance: { fields: ['content'], search: formattedQuery, sort: 'desc' } },
    include: {
      sender: { select: { id: true, fullname: true, avatarUrl: true } },
      reactions: { select: { icon: true, userId: true } },
      chatRoom: { 
        select: { 
          id: true, type: true, name: true, avatarUrl: true, 
          participants: { include: { user: { select: { id: true, fullname: true, avatarUrl: true } } } } 
        } 
      }
    }
  });

  return messages;
}

module.exports = {
  sendMessage,
  sendSystemEvent,
  pinMessage,
  getMessages,
  getConversations,
  editMessage,
  deleteMessage,
  toggleReaction,
  markAsRead,
  searchGlobalMessages
};
