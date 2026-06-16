const { AppError } = require('../../middleware/errorHandler');
const notificationService = require('../notification/notification.service');
const { TASK_STATUS, validateTransition } = require('../task/task.stateMachine');
const { detectSpamBids } = require('../../utils/antifraud');
const bidRepository = require('./bid.repository');
const taskRepository = require('../task/task.repository');
const prisma = require('../../config/prisma'); // Keep for user queries temporarily if needed
const logger = require('../../utils/logger');
const chatRoomService = require('../chat/chat-room.service');
const chatService = require('../chat/chat.service');
const taskChatSyncService = require('../chat/taskChatSync.service');

/**
 * Place a new bid on a task
 */
async function createBid(taskId, freelancerId, data) {
  const task = await taskRepository.findById(taskId);
  
  if (!task || task.deletedAt) {
    throw new AppError('Vazifa topilmadi', 404);
  }
  
  if (task.status !== TASK_STATUS.OPEN) {
    throw new AppError('Ushbu vazifaga taklif berish yopilgan', 400);
  }

  if (task.clientId === freelancerId) {
    throw new AppError('O\'z vazifangizga taklif bera olmaysiz', 400);
  }

  // Check if price is within budget
  if (data.proposedPrice > task.priceMax) {
    throw new AppError(`Maksimal byudjet ${task.priceMax} so'm`, 400);
  }
  if (data.proposedPrice <= 0) {
    throw new AppError("Taklif qilinayotgan narx noldan katta bo'lishi kerak", 400);
  }

  // Anti-fraud spam check
  const isSpam = await detectSpamBids(freelancerId);
  if (isSpam) {
    throw new AppError('Juda ko\'p taklif yubordingiz. Iltimos 1 soat kuting.', 429);
  }

  // Upsert bid via Repository
  const bid = await bidRepository.upsert(taskId, freelancerId, data);

  // Notify client of new bid
  const freelancer = await prisma.user.findUnique({ where: { id: freelancerId }, select: { fullname: true } });
  await notificationService.notifyNewBid(task.clientId, freelancer.fullname, data.proposedPrice, taskId);

  return bid;
}

/**
 * Get all bids for a task (Blind Bidding implemented)
 */
async function getTaskBids(taskId, userId) {
  const task = await taskRepository.findById(taskId);
  
  if (!task) throw new AppError('Vazifa topilmadi', 404);

  const bids = await bidRepository.findByTask(taskId, {
    freelancer: {
      select: {
        id: true,
        fullname: true,
        avatarUrl: true,
        isVip: true,
        badge: true,
        ratingSum: true,
        ratingCount: true,
        skills: true
      }
    }
  });

  // Sort: VIP first, then by average rating DESC
  bids.sort((a, b) => {
    if (a.freelancer.isVip && !b.freelancer.isVip) return -1;
    if (!a.freelancer.isVip && b.freelancer.isVip) return 1;

    const ratingA = a.freelancer.ratingCount > 0 ? (a.freelancer.ratingSum / a.freelancer.ratingCount) : 0;
    const ratingB = b.freelancer.ratingCount > 0 ? (b.freelancer.ratingSum / b.freelancer.ratingCount) : 0;

    return ratingB - ratingA;
  });

  // Blind Bidding System
  const isClient = task.clientId === userId;
  
  const redactedBids = bids.map(bid => {
    const isOwner = bid.freelancerId === userId;
    if (!isClient && !isOwner) {
      return {
        ...bid,
        proposedPrice: null,
        message: '[Raqobat uchun yashirilgan]',
        counterPrice: null,
        counterMessage: null
      };
    }
    return bid;
  });

  return redactedBids;
}

/**
 * Client accepts a bid
 */
async function acceptBid(taskId, bidId, clientId) {
  const task = await taskRepository.findById(taskId);
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);
  
  if (task.isCoWorking) {
    throw new AppError('Jamoaviy vazifa uchun jamoa yig\'ish (assembleTeam) ishlatilishi kerak', 400);
  }

  validateTransition(task.status, TASK_STATUS.ASSIGNED);

  const bid = await bidRepository.findById(bidId);
  if (!bid || bid.taskId !== taskId) throw new AppError('Taklif topilmadi', 404);

  const agreedPrice = bid.counterAccepted ? (bid.counterPrice || bid.proposedPrice) : bid.proposedPrice;
  
  try {
    const updatedTask = await bidRepository.acceptBidTransaction(taskId, bidId, bid.freelancerId, agreedPrice);
    
    // Notify Freelancer
    await notificationService.notifyTaskAssigned(bid.freelancerId, task.title, taskId);
    
    // Integration: Chat System Event
    try {
      const room = await chatRoomService.getOrCreateTaskRoom(clientId, taskId);
      await chatService.sendSystemEvent(room.id, "🤝 Taklif qabul qilindi! Vazifa ijrochiga biriktirildi. Ishni boshlashingiz mumkin.");
      await taskChatSyncService.syncTaskRoomParticipants(taskId);
    } catch (err) { logger.warn(`Chat/socket side-effect error: ${err.message}`); }
    
    return updatedTask;
  } catch (err) {
    throw new AppError(err.message, 400);
  }
}

/**
 * Client sends a counter-offer
 */
async function createCounterOffer(bidId, clientId, data) {
  const bid = await bidRepository.findById(bidId, { task: true });

  if (!bid) throw new AppError('Taklif topilmadi', 404);
  if (bid.task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);
  if (bid.task.status !== TASK_STATUS.OPEN) throw new AppError('Vazifa ochiq emas', 400);

  if (data.counterPrice !== undefined && data.counterPrice <= 0) {
    throw new AppError("Narx noldan katta bo'lishi kerak", 400);
  }

  return bidRepository.update(bidId, {
    counterPrice: data.counterPrice,
    counterMessage: data.counterMessage,
    counterAt: new Date()
  });
}

/**
 * Freelancer accepts counter-offer
 */
async function acceptCounterOffer(bidId, freelancerId) {
  const bid = await bidRepository.findById(bidId, { task: true });
  
  if (!bid) throw new AppError('Taklif topilmadi', 404);
  if (bid.freelancerId !== freelancerId) throw new AppError('Ruxsat yo\'q', 403);
  if (!bid.counterPrice) throw new AppError('Counter-offer mavjud emas', 400);

  if (bid.task.status !== TASK_STATUS.OPEN) {
    throw new AppError('Vazifa ochiq emas', 400);
  }

  try {
    const updatedTask = await bidRepository.acceptCounterOfferTransaction(bid.taskId, bidId, freelancerId, bid.counterPrice);
    
    await notificationService.notifyTaskAssigned(freelancerId, bid.task.title, bid.taskId);
    
    // Integration: Chat System Event
    try {
      const room = await chatRoomService.getOrCreateTaskRoom(freelancerId, bid.taskId);
      await chatService.sendSystemEvent(room.id, `🤝 Counter-offer qabul qilindi! Kelishilgan narx: ${bid.counterPrice} UZS. Ishni boshlashingiz mumkin.`);
      await taskChatSyncService.syncTaskRoomParticipants(bid.taskId);
    } catch (err) { logger.warn(`Chat/socket side-effect error: ${err.message}`); }

    return updatedTask;
  } catch (err) {
    throw new AppError(err.message, 400);
  }
}

/**
 * Client assembles a team for a co-working task
 */
async function assembleTeam(taskId, clientId, teamMembers) {
  const task = await taskRepository.findById(taskId);
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);
  if (!task.isCoWorking) throw new AppError('Vazifa jamoaviy emas', 400);

  validateTransition(task.status, TASK_STATUS.ASSIGNED);

  if (!Array.isArray(teamMembers) || teamMembers.length === 0) {
    throw new AppError('Jamoa a\'zolari tanlanmagan', 400);
  }
  if (teamMembers.length > task.maxCollaborators) {
    throw new AppError(`Maksimal jamoa a'zolari soni ${task.maxCollaborators} kishi`, 400);
  }

  // Fetch all valid bids for this task to verify input
  const validBids = await bidRepository.findByTask(taskId);
  let totalShare = 0;

  for (const member of teamMembers) {
    if (typeof member.sharePercent !== 'number' || !Number.isInteger(member.sharePercent) || member.sharePercent <= 0 || member.sharePercent > 100) {
      throw new AppError("Har bir a'zoning foizi 1 dan 100 gacha bo'lgan butun son bo'lishi kerak", 400);
    }
    totalShare += member.sharePercent;

    const bid = validBids.find(b => b.id === member.bidId);
    if (!bid) {
      throw new AppError("Noto'g'ri taklif (bid) tanlandi yoki u ushbu vazifaga tegishli emas", 400);
    }
    if (bid.freelancerId !== member.freelancerId) {
      throw new AppError("Taklif egasi va ijrochi mos kelmadi", 400);
    }
  }

  if (totalShare !== 100) {
    throw new AppError('Foizlar yig\'indisi 100% ga teng bo\'lishi kerak', 400);
  }

  try {
    const updatedTask = await bidRepository.assembleTeamTransaction(taskId, teamMembers);
    
    // Notify all accepted freelancers
    for (const member of teamMembers) {
      await notificationService.notifyTaskAssigned(member.freelancerId, task.title, taskId);
    }

    // Integration: Chat System Event
    try {
      const room = await chatRoomService.getOrCreateTaskRoom(clientId, taskId);
      await chatService.sendSystemEvent(room.id, `👥 Jamoa yig'ildi! ${teamMembers.length} ta ijrochi vazifaga biriktirildi. Ishni boshlashingiz mumkin.`);
      await taskChatSyncService.syncTaskRoomParticipants(taskId);
    } catch (err) { logger.warn(`Chat/socket side-effect error: ${err.message}`); }

    return updatedTask;
  } catch (err) {
    throw new AppError(err.message, 400);
  }
}

module.exports = {
  createBid,
  getTaskBids,
  acceptBid,
  createCounterOffer,
  acceptCounterOffer,
  assembleTeam
};
