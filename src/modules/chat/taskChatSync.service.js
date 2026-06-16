const prisma = require('../../config/prisma');
const chatService = require('./chat.service');
const { getIO } = require('../../config/socket');
const logger = require('../../utils/logger');

/**
 * Synchronize task chat room participants based on current task state.
 * Source of truth: Task (client + freelancer + accepted collaborators).
 */
async function syncTaskRoomParticipants(taskId) {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { 
        collaborators: { 
          where: { status: 'ACCEPTED' } 
        } 
      }
    });

    if (!task) return;

    const room = await prisma.chatRoom.findUnique({ where: { taskId } });
    if (!room) return; // Room will be created by getOrCreateTaskRoom if needed

    const desired = new Map();
    desired.set(task.clientId, 'OWNER');
    
    if (task.freelancerId) {
      desired.set(task.freelancerId, 'MEMBER');
    }

    task.collaborators.forEach(c => {
      if (!desired.has(c.freelancerId)) {
        desired.set(c.freelancerId, 'MEMBER');
      }
    });

    const currentParticipants = await prisma.chatParticipant.findMany({
      where: { chatRoomId: room.id }
    });

    // 1. Add missing participants
    const toAdd = [];
    const rolesToUpdate = [];

    for (const [userId, role] of desired) {
      const isAlreadyIn = currentParticipants.find(p => p.userId === userId);
      if (!isAlreadyIn) {
        toAdd.push({ chatRoomId: room.id, userId, role });
      } else if (isAlreadyIn.role !== role) {
        rolesToUpdate.push({ id: isAlreadyIn.id, role });
      }
    }

    if (toAdd.length > 0) {
      await prisma.chatParticipant.createMany({ data: toAdd });
      
      const addedUserIds = toAdd.map(a => a.userId);
      const newParticipants = await prisma.chatParticipant.findMany({
        where: { chatRoomId: room.id, userId: { in: addedUserIds } },
        include: { user: { select: { id: true, fullname: true, username: true, avatarUrl: true } } }
      });
      
      const names = newParticipants.map(p => p.user.fullname).join(', ');
      await chatService.sendSystemEvent(room.id, `👋 ${names} guruhga qo'shildi.`);

      try {
        const io = getIO();
        newParticipants.forEach(p => io.to(`chat_${room.id}`).emit('participant_added', { chatRoomId: room.id, participant: p }));
      } catch (e) {}
    }

    if (rolesToUpdate.length > 0) {
      await Promise.all(rolesToUpdate.map(async (ru) => {
        const updated = await prisma.chatParticipant.update({
          where: { id: ru.id },
          data: { role: ru.role },
          include: { user: { select: { id: true, fullname: true, username: true, avatarUrl: true } } }
        });
        try {
          const io = getIO();
          io.to(`chat_${room.id}`).emit('participant_updated', { chatRoomId: room.id, participant: updated });
        } catch (e) {}
      }));
    }

    // 2. Remove participants who are no longer part of the task
    const toRemoveIds = [];
    for (const p of currentParticipants) {
      if (!desired.has(p.userId)) {
        toRemoveIds.push(p.id);
      }
    }

    if (toRemoveIds.length > 0) {
      const removedParticipants = currentParticipants.filter(p => toRemoveIds.includes(p.id));
      await prisma.chatParticipant.deleteMany({ where: { id: { in: toRemoveIds } } });
      
      await chatService.sendSystemEvent(room.id, `👋 ${toRemoveIds.length} ta a'zo guruhdan chiqarildi (vazifa tarkibi o'zgardi).`);

      try {
        const io = getIO();
        removedParticipants.forEach(p => io.to(`chat_${room.id}`).emit('participant_removed', { chatRoomId: room.id, userId: p.userId }));
      } catch (e) {}
    }
  } catch (err) {
    logger.error(`Failed to sync task room participants for task ${taskId}: ${err.message}`);
  }
}

/**
 * Archive task room when task is completed or canceled.
 * Sets the room to read-only and marks as archived.
 */
async function archiveTaskRoom(taskId) {
  try {
    const room = await prisma.chatRoom.findUnique({ where: { taskId } });
    if (!room) return;

    await prisma.chatRoom.update({
      where: { id: room.id },
      data: { 
        isArchived: true,
        settings: {
          ...((room.settings && typeof room.settings === 'object') ? room.settings : {}),
          isReadOnly: true
        }
      }
    });
    
    await chatService.sendSystemEvent(room.id, `📁 Vazifa yakunlandi. Chat arxivlandi (faqat o'qish uchun).`);
  } catch (err) {
    logger.error(`Failed to archive task room for task ${taskId}: ${err.message}`);
  }
}

module.exports = {
  syncTaskRoomParticipants,
  archiveTaskRoom
};
