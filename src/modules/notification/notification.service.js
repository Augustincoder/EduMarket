const { getBot } = require('../../config/bot');
const prisma = require('../../config/prisma');
const logger = require('../../utils/logger');
const env = require('../../config/env');
const { admin } = require('../../config/firebase');
const { getIO } = require('../../config/socket');

/**
 * Helper to check user notification preferences
 */
async function shouldSendNotification(userId, prefKey) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notifPrefs: true, pushToken: true }
  });

  if (!user) return { shouldSend: true, pushToken: null };

  const notifPrefs = user.notifPrefs || {};
  // If preference explicitly set to false, don't send
  if (notifPrefs[prefKey] === false) {
    return { shouldSend: false, pushToken: user.pushToken };
  }

  return { shouldSend: true, pushToken: user.pushToken };
}

/**
 * Helper to send Telegram message safely
 */
async function sendTelegramMessage(telegramId, text, inlineKeyboard = null) {
  try {
    const bot = getBot();
    const options = { parse_mode: 'HTML' };
    
    if (inlineKeyboard) {
      options.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    
    await bot.sendMessage(telegramId, text, options);
    return true;
  } catch (err) {
    // If user blocked bot, Telegram returns 403 Forbidden
    if (err.response && err.response.statusCode === 403) {
      logger.warn(`User ${telegramId} blocked the bot. Skipping notification.`);
    } else {
      logger.error(`Failed to send notification to ${telegramId}: ${err.message}`);
    }
    return false;
  }
}

/**
 * Helper to send Firebase Push Notification
 */
async function sendPushNotification(token, title, body, data = {}) {
  if (!token) return false;

  try {
    const message = {
      notification: { title, body },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK', // Legacy but still used by some libs
      },
      token
    };

    await admin.messaging().send(message);
    return true;
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      logger.warn(`Push token no longer valid. Removing...`);
      // Optionally remove from DB
    } else {
      logger.error(`Firebase Push error: ${err.message}`);
    }
    return false;
  }
}

// ─── Notification Methods ──────────────────────────────────────────────────────

async function notifyNewBid(taskClientId, freelancerName, bidAmount, taskId) {
  const title = "📬 Yangi taklif!";
  const text = `<b>${freelancerName}</b> sizning vazifangizga <b>${bidAmount} so'm</b> taklif qildi.`;
  
  await createDbNotification(taskClientId, 'new_bid', title, text.replace(/<[^>]*>?/gm, ''), `/tasks/${taskId}`);

  const { shouldSend, pushToken } = await shouldSendNotification(taskClientId, 'newBid');
  if (!shouldSend) return;

  const client = await prisma.user.findUnique({ where: { id: taskClientId }, select: { telegramId: true } });
  if (!client) return;
  const keyboard = [[{ text: "Vazifani ko'rish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=task_${taskId}` }]];

  await sendTelegramMessage(client.telegramId.toString(), text, keyboard);
  
  if (pushToken) {
    await sendPushNotification(pushToken, title, text.replace(/<[^>]*>?/gm, ''), { taskId, type: 'new_bid' });
  }
}

async function notifyTaskAssigned(freelancerId, taskTitle, taskId) {
  const title = "🎉 Tabriklaymiz!";
  const text = `Siz <b>"${taskTitle}"</b> vazifasini bajarish uchun tanlandingiz!`;

  await createDbNotification(freelancerId, 'task_assigned', title, text.replace(/<[^>]*>?/gm, ''), `/tasks/${taskId}`);

  const { shouldSend, pushToken } = await shouldSendNotification(freelancerId, 'taskAssigned');
  if (!shouldSend) return;

  const freelancer = await prisma.user.findUnique({ where: { id: freelancerId }, select: { telegramId: true } });
  if (!freelancer) return;
  const keyboard = [[{ text: "Vazifani ko'rish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=task_${taskId}` }]];

  await sendTelegramMessage(freelancer.telegramId.toString(), text, keyboard);

  if (pushToken) {
    await sendPushNotification(pushToken, title, text.replace(/<[^>]*>?/gm, ''), { taskId, type: 'task_assigned' });
  }
}

async function notifyChatMessage(recipientId, senderName, chatRoomId) {
  const title = "💬 Yangi xabar";
  const text = `<b>${senderName}</b> sizga xabar yubordi.`;

  await createDbNotification(recipientId, 'chat_message', title, text.replace(/<[^>]*>?/gm, ''), `/chat/${chatRoomId}`);

  const { shouldSend, pushToken } = await shouldSendNotification(recipientId, 'chatMessage');
  if (!shouldSend) return;

  const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { telegramId: true } });
  if (!recipient) return;
  const keyboard = [[{ text: "Chatni ochish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=chat_${chatRoomId}` }]];

  await sendTelegramMessage(recipient.telegramId.toString(), text, keyboard);

  if (pushToken) {
    await sendPushNotification(pushToken, title, text.replace(/<[^>]*>?/gm, ''), { chatRoomId, type: 'chat_message' });
  }
}

/**
 * Bulk chat notifications optimized for group chats (Fixing 3.6 N+1 issue)
 */
async function notifyChatMessageBulk(recipientIds, senderName, chatRoomId) {
  if (!recipientIds || recipientIds.length === 0) return;

  const title = "💬 Yangi xabar";
  const text = `<b>${senderName}</b> sizga xabar yubordi.`;
  const plainText = text.replace(/<[^>]*>?/gm, '');
  const actionUrl = `/chat/${chatRoomId}`;

  // 1. Create DB notifications in bulk
  await prisma.notification.createMany({
    data: recipientIds.map(userId => ({
      userId,
      type: 'chat_message',
      title,
      message: plainText,
      actionUrl
    }))
  });

  // Emit socket events for DB notifications (still needed for real-time UI updates)
  // Note: createMany doesn't return IDs or full objects, so we just emit a generic event if needed
  // or fetch them back. Usually, a refresh event or simple 'new_notification' is enough.
  recipientIds.forEach(userId => {
    try {
      getIO().to(`user_${userId}`).emit('new_notification', { type: 'chat_message', title, message: plainText, actionUrl });
    } catch (err) { logger.warn(`Socket emit error: ${err.message}`); }
  });

  // 2. Fetch user settings in bulk
  const users = await prisma.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, telegramId: true, pushToken: true, notifPrefs: true }
  });

  const keyboard = [[{ text: "Chatni ochish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=chat_${chatRoomId}` }]];

  // 3. Send Telegram and Push in parallel chunks
  const chunkSize = 10;
  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);
    await Promise.allSettled(chunk.map(async (user) => {
      const notifPrefs = user.notifPrefs || {};
      if (notifPrefs.chatMessage === false) return;

      if (user.telegramId) {
        await sendTelegramMessage(user.telegramId.toString(), text, keyboard);
      }
      
      if (user.pushToken) {
        await sendPushNotification(user.pushToken, title, plainText, { chatRoomId, type: 'chat_message' });
      }
    }));
  }
}

async function notifyDeadlineApproaching(freelancerId, taskTitle, taskId) {
  const title = "⏰ Muddat yaqinlashmoqda!";
  const text = `<b>"${taskTitle}"</b> vazifasini topshirish muddati tugashiga 24 soatdan kam vaqt qoldi.`;

  await createDbNotification(freelancerId, 'deadline', title, text.replace(/<[^>]*>?/gm, ''), `/tasks/${taskId}`);

  const { shouldSend, pushToken } = await shouldSendNotification(freelancerId, 'deadlineReminder');
  if (!shouldSend) return;

  const freelancer = await prisma.user.findUnique({ where: { id: freelancerId }, select: { telegramId: true } });
  if (!freelancer) return;
  const keyboard = [[{ text: "Vazifani ko'rish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=task_${taskId}` }]];

  await sendTelegramMessage(freelancer.telegramId.toString(), text, keyboard);

  if (pushToken) {
    await sendPushNotification(pushToken, title, text.replace(/<[^>]*>?/gm, ''), { taskId, type: 'deadline' });
  }
}

async function notifyReviewReceived(recipientId, senderName, rating, taskId) {
  const stars = '⭐'.repeat(rating);
  const title = "Yangi baho!";
  const text = `📈 <b>Yangi baho!</b>\n\n<b>${senderName}</b> sizning ishingizni baholadi: ${stars}`;

  await createDbNotification(recipientId, 'review', title, text.replace(/<[^>]*>?/gm, ''), `/tasks/${taskId}`);

  if (!(await shouldSendNotification(recipientId, 'reviewReminder')).shouldSend) return;

  const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { telegramId: true } });
  if (!recipient) return;
  
  await sendTelegramMessage(recipient.telegramId.toString(), text);
}

async function autoCompleted(task) {
  const msg =
    `✅ <b>"${task.title}"</b> vazifasi avtomatik yakunlandi.\n` +
    `(Mijoz 48 soat ichida javob bermadi)`;

  if (task.freelancer) {
    await createDbNotification(task.freelancer.id, 'status_changed', "Vazifa avtomatik yakunlandi", msg.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  if (task.client) {
    await createDbNotification(task.client.id, 'status_changed', "Vazifa avtomatik yakunlandi", msg.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }

  if (task.freelancer && (await shouldSendNotification(task.freelancer.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.freelancer.telegramId.toString(), msg);
  }
  if (task.client && (await shouldSendNotification(task.client.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.client.telegramId.toString(), msg);
  }
}

async function disputeOpened(task, _dispute) {
  const msgClient = `⚠️ <b>Nizo ochildi</b>\n\n<b>"${task.title}"</b> vazifasi bo'yicha nizo ochildi. Admin tez orada ko'rib chiqadi.`;

  if (task.client) {
    await createDbNotification(task.client.id, 'dispute', "Nizo ochildi", msgClient.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  if (task.freelancer) {
    await createDbNotification(task.freelancer.id, 'dispute', "Nizo ochildi", msgClient.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }

  if (task.client && (await shouldSendNotification(task.client.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.client.telegramId.toString(), msgClient);
  }
  if (task.freelancer && (await shouldSendNotification(task.freelancer.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.freelancer.telegramId.toString(), msgClient);
  }
  // Optional: send to admin channel or all admins
}

async function disputeResolved(task, dispute, winner) {
  const msg = `⚖️ <b>Nizo hal qilindi</b>\n\n<b>"${task.title}"</b> vazifasi bo'yicha nizo <b>${winner === 'CLIENT' ? 'MIJOZ' : 'IJROCHI'}</b> foydasiga hal qilindi.\n\nIzoh: ${dispute.adminNotes || 'Izohsiz'}`;
  
  if (task.client) {
    await createDbNotification(task.client.id, 'dispute', "Nizo hal qilindi", msg.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  if (task.freelancer) {
    await createDbNotification(task.freelancer.id, 'dispute', "Nizo hal qilindi", msg.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  
  if (task.client && (await shouldSendNotification(task.client.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.client.telegramId.toString(), msg);
  }
  if (task.freelancer && (await shouldSendNotification(task.freelancer.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.freelancer.telegramId.toString(), msg);
  }
}

async function taskCompleted(task) {
  const msgFreelancer = `✅ <b>Vazifa qabul qilindi</b>\n\n<b>"${task.title}"</b> vazifasi muvaffaqiyatli qabul qilindi! To'lov o'tkaziladi.`;
  const msgClient = `✅ <b>Vazifa yakunlandi</b>\n\n<b>"${task.title}"</b> vazifasi yakunlandi. Hamkorlik uchun rahmat!`;
  
  if (task.freelancer) {
    await createDbNotification(task.freelancer.id, 'status_changed', "Vazifa qabul qilindi", msgFreelancer.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  if (task.client) {
    await createDbNotification(task.client.id, 'status_changed', "Vazifa yakunlandi", msgClient.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  
  if (task.freelancer && (await shouldSendNotification(task.freelancer.id, 'taskStatusChanged')).shouldSend) {
    sendTelegramMessage(task.freelancer.telegramId.toString(), msgFreelancer).catch(e => logger.error(e));
  }
  if (task.client && (await shouldSendNotification(task.client.id, 'taskStatusChanged')).shouldSend) {
    sendTelegramMessage(task.client.telegramId.toString(), msgClient).catch(e => logger.error(e));
  }
}

async function revisionRequested(task, note) {
  const msg = `🔄 <b>Qayta ishlash so'raldi</b>\n\n<b>"${task.title}"</b> vazifasini mijoz qayta ishlashga qaytardi.\n\nIzoh: ${note || 'Izohsiz'}`;
  
  if (task.freelancer) {
    await createDbNotification(task.freelancer.id, 'status_changed', "Qayta ishlash so'raldi", msg.replace(/<[^>]*>?/gm, ''), `/tasks/${task.id}`);
  }
  if (task.freelancer && (await shouldSendNotification(task.freelancer.id, 'taskStatusChanged')).shouldSend) {
    await sendTelegramMessage(task.freelancer.telegramId.toString(), msg);
  }
}

async function smartMatchNotify(freelancer, task) {
  const text = `🎯 <b>Sizga mos yangi ish chiqdi!</b>\n\n<b>"${task.title}"</b>\nKategoriya: ${task.category}\nNarx: ${task.priceMin} - ${task.priceMax} so'm\n\nVIP mutaxassis bo'lganingiz uchun sizga ushbu xabar hammadan oldin yuborildi. Darhol taklif qoldiring!`;
  const keyboard = [[{ text: "Vazifani ko'rish", url: `https://t.me/${env.BOT_USERNAME}/app?startapp=task_${task.id}` }]];
  await sendTelegramMessage(freelancer.telegramId.toString(), text, keyboard);
}

async function referralBonusNotify(user, daysAdded) {
  const text = `🎁 <b>Referral Bonus!</b>\n\nSiz taklif qilgan do'stingiz VIP paket sotib oldi! Sizga <b>+${daysAdded} kun</b> bepul VIP taqdim etildi.`;
  await sendTelegramMessage(user.telegramId.toString(), text);
}

async function notifyAdminsVerifyStudent(user, fileId) {
  const text = `🎓 <b>Yangi talaba guvohnomasi!</b>\n\nFoydalanuvchi: <b>${user.fullname}</b> (ID: ${user.id}, TG: @${user.username || ''})\nGuvohnoma File ID: <code>${fileId}</code>\n\nUni tasdiqlash yoki rad etish uchun quyidagi tugmalarni bosing.`;
  const keyboard = [
    [
      { text: "Tasdiqlash ✅", callback_data: `verify_student_approve:${user.id}` },
      { text: "Rad etish ❌", callback_data: `verify_student_reject:${user.id}` }
    ]
  ];
  for (const adminId of env.ADMIN_TELEGRAM_IDS) {
    await sendTelegramMessage(adminId.toString(), text, keyboard);
  }
}

async function notifyWarning(userId, message) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
  if (!user) return;
  const text = `⚠️ <b>Ogohlantirish!</b>\n\n${message}`;
  await sendTelegramMessage(user.telegramId.toString(), text);
}

async function notifyBroadcast(telegramId, text) {
  await sendTelegramMessage(telegramId.toString(), text);
}

// ─── CRUD DB Methods for Inbox ──────────────────────────────────────────────────

async function getNotifications(userId, limit = 20, cursor = null) {
  const where = { userId };
  const query = {
    where,
    take: limit + 1,
    orderBy: { createdAt: 'desc' }
  };
  
  if (cursor) {
    query.cursor = { id: cursor };
    query.skip = 1;
  }
  
  const notifications = await prisma.notification.findMany(query);
  const unreadCount = await prisma.notification.count({ where: { userId, status: 'UNREAD' } });
  
  let nextCursor = null;
  if (notifications.length > limit) {
    const nextItem = notifications.pop();
    nextCursor = nextItem.id;
  }
  
  const mappedNotifications = notifications.map(notif => ({
    ...notif,
    isRead: notif.status === 'READ'
  }));
  
  return { notifications: mappedNotifications, unreadCount, nextCursor };
}

async function markAsRead(notificationId, userId) {
  const notif = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notif) throw new Error("Bildirishnoma topilmadi");
  
  if (String(notif.userId) !== String(userId)) {
    throw new Error("Siz ushbu bildirishnomaga ruxsatga ega emassiz");
  }
  
  return prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'READ' }
  });
}

async function markAllAsRead(userId) {
  return prisma.notification.updateMany({
    where: { userId, status: 'UNREAD' },
    data: { status: 'READ' }
  });
}

async function createDbNotification(userId, type, title, message, actionUrl = null) {
  const notif = await prisma.notification.create({
    data: { userId, type, title, message, actionUrl }
  });

  try {
    getIO().to(`user_${userId}`).emit('new_notification', notif);
  } catch (err) {
    logger.error(`Error emitting new_notification: ${err.message}`);
  }

  return notif;
}

module.exports = {
  notifyNewBid,
  notifyTaskAssigned,
  notifyChatMessage,
  notifyChatMessageBulk,
  notifyDeadlineApproaching,
  notifyReviewReceived,
  autoCompleted,
  disputeOpened,
  disputeResolved,
  taskCompleted,
  revisionRequested,
  smartMatchNotify,
  referralBonusNotify,
  notifyAdminsVerifyStudent,
  notifyWarning,
  notifyBroadcast,
  getNotifications,
  markAsRead,
  markAllAsRead,
  createDbNotification
};
