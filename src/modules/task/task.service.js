const prisma = require('../../config/prisma');
const taskRepository = require('./task.repository');
const { AppError } = require('../../middleware/errorHandler');
const { TASK_STATUS, validateTransition } = require('./task.stateMachine');
const { getIO, isUserOnline } = require('../../config/socket');
const notificationService = require('../notification/notification.service');
const logger = require('../../utils/logger');
const chatRoomService = require('../chat/chat-room.service');
const chatService = require('../chat/chat.service');
const taskChatSyncService = require('../chat/taskChatSync.service');

/**
 * Creates a new task
 */
async function createTask(clientId, data) {
  // Phase 14: Calculate rush fee if urgent (e.g. 20% premium logic could go here)
  const rushFee = data.isUrgent ? Math.floor(data.priceMin * 0.2) : 0;
  
  let maxCollaborators = data.maxCollaborators || 1;
  if (data.isCoWorking) {
    if (!Number.isInteger(maxCollaborators) || maxCollaborators < 2 || maxCollaborators > 10) {
      throw new AppError('Jamoa a\'zolari soni 2 dan 10 gacha bo\'lgan butun son bo\'lishi kerak', 400);
    }
  } else {
    maxCollaborators = 1;
  }

  const task = await taskRepository.create({
    data: {
      clientId,
      category: data.category,
      title: data.title,
      description: data.description,
      priceMin: data.priceMin,
      priceMax: data.priceMax,
      deadline: new Date(data.deadline),
      attachmentFileIds: data.attachmentFileIds || [],
      status: TASK_STATUS.OPEN,
      isUrgent: data.isUrgent,
      rushFee,
      metadata: data.metadata || null,
      isCoWorking: data.isCoWorking || false,
      maxCollaborators: maxCollaborators,
      paymentSplitType: data.paymentSplitType || 'EQUAL'
    }
  });

  // Phase 14: Smart Matching logic (EduMarket V2)
  // Find VIP freelancers who have this category in their skills
  const matchedVips = await prisma.user.findMany({
    where: {
      isVip: true,
      skills: {
        has: data.category
      }
    },
    select: { id: true, telegramId: true },
    take: 100 // Prevent memory overload if thousands match
  });

  // Send notifications asynchronously in chunks to prevent blocking/rate limits
  Promise.resolve().then(async () => {
    try {
      const chunkSize = 25;
      for (let i = 0; i < matchedVips.length; i += chunkSize) {
        const chunk = matchedVips.slice(i, i + chunkSize);
        await Promise.allSettled(
          chunk.map(freelancer => notificationService.smartMatchNotify(freelancer, task))
        );
      }
    } catch (err) {
      logger.error(`Smart match notification error: ${err.message}`);
    }
  });

  return task;
}

/**
 * Get task by ID
 */
async function getTaskById(id) {
  const task = await taskRepository.findUnique({
    where: { id },
    include: {
      client: {
        select: {
          id: true,
          fullname: true,
          avatarUrl: true,
          ratingSum: true,
          ratingCount: true,
          isVip: true,
          badge: true
        }
      },
      freelancer: {
        select: {
          id: true,
          fullname: true,
          avatarUrl: true,
          ratingSum: true,
          ratingCount: true,
          isVip: true,
          badge: true
        }
      },
      // Include accepted bid if any
      bids: {
        where: { isAccepted: true },
        select: { id: true, proposedPrice: true, message: true }
      },
      // Include collaborators for co-working
      collaborators: {
        include: {
          freelancer: {
            select: {
              id: true,
              fullname: true,
              avatarUrl: true,
              ratingSum: true,
              ratingCount: true,
              isVip: true,
              badge: true
            }
          }
        }
      },
      dispute: {
        select: {
          id: true,
          reason: true,
          status: true,
          adminNotes: true
        }
      },
      delivery: {
        select: {
          id: true,
          submittedAt: true,
          revisionCount: true,
          clientViewedAt: true,
          clientAcceptedAt: true,
          fullRevealedAt: true
        }
      },
      reviews: {
        select: {
          id: true,
          fromUserId: true
        }
      }
    }
  });

  if (!task || task.deletedAt) {
    throw new AppError('Vazifa topilmadi', 404, 'TASK_NOT_FOUND');
  }

  // Populate dynamic online status
  if (task.client) {
    task.client.isOnline = await isUserOnline(task.client.id);
  }
  if (task.freelancer) {
    task.freelancer.isOnline = await isUserOnline(task.freelancer.id);
  }

  return task;
}

/**
 * Get user's tasks by role (Client/Freelancer)
 */
async function getMyTasks(userId, filters) {
  const { role, status } = filters;

  const where = {};
  if (role === 'CLIENT') {
    where.clientId = userId;
  } else if (role === 'FREELANCER') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isFreelancer: true } });
    if (!user || !user.isFreelancer) {
      throw new AppError('Siz freelancer emassiz. Avval freelancer rejimini faollashtiring.', 403);
    }
    where.OR = [
      { freelancerId: userId },
      { collaborators: { some: { freelancerId: userId, status: 'ACCEPTED' } } }
    ];
  } else {
    // Both
    where.OR = [
      { clientId: userId },
      { freelancerId: userId },
      { collaborators: { some: { freelancerId: userId, status: 'ACCEPTED' } } }
    ];
  }

  if (status) {
    if (status === 'OPEN') {
      where.status = 'OPEN';
    } else {
      where.status = status;
    }
  }

  const tasks = await taskRepository.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: {
      client: { select: { id: true, fullname: true, avatarUrl: true } },
      freelancer: { select: { id: true, fullname: true, avatarUrl: true } },
      _count: { select: { bids: true } }
    }
  });

  return tasks;
}

/**
 * Promote a task to top of listings
 */
async function promoteTask(taskId, clientId, packageType) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);
  if (task.status !== TASK_STATUS.OPEN) throw new AppError('Faqat ochiq vazifalar ko\'tarish mumkin', 400);

  // Calculate duration based on packageType
  let hoursToAdd;
  if (packageType === 'PIN_12H') hoursToAdd = 12;
  else if (packageType === 'PIN_24H') hoursToAdd = 24;
  else hoursToAdd = 72; // Default 3 days

  const promotedUntil = new Date();
  promotedUntil.setHours(promotedUntil.getHours() + hoursToAdd);

  return taskRepository.update({
    where: { id: taskId },
    data: { promotedUntil }
  });
}

/**
 * List tasks using cursor-based pagination (Phase 13 improvement)
 * Phase 5: Task DNA Matching Engine
 */
async function listTasks(filters, userId) {
  let { cursor, limit, category, status, query, minPrice, maxPrice, sort } = filters;
  limit = parseInt(limit, 10) || 20;
  if (limit > 50) limit = 50;

  // Build where clause
  const where = {
    deletedAt: null, // Soft delete filter
  };

  if (category) where.category = category;
  if (status) where.status = status;
  
  // Price Filtering: Filter by priceMin and priceMax range
  if (minPrice || maxPrice) {
    if (minPrice) {
      where.priceMax = { gte: parseInt(minPrice, 10) };
    }
    if (maxPrice) {
      where.priceMin = { ...where.priceMin, lte: parseInt(maxPrice, 10) };
    }
  }
  
  // Phase 14: Full-text search using Postgres tsvector
  if (query) {
    const formattedQuery = query.trim().split(/\s+/).join(' | ');
    where.OR = [
      { title: { search: formattedQuery } },
      { description: { search: formattedQuery } }
    ];
  }

  // Cursor logic
  if (cursor) {
    where.id = { lt: cursor }; // 'lt' because we order by 'desc'
  }

  // Build OrderBy
  const orderBy = [{ promotedUntil: { sort: 'desc', nulls: 'last' } }];
  
  if (sort === 'priceAsc') {
    orderBy.push({ priceMin: 'asc' });
  } else if (sort === 'priceDesc') {
    orderBy.push({ priceMin: 'desc' });
  } else {
    orderBy.push({ createdAt: 'desc' }); // newest as default
  }

  // Fetch tasks
  const tasks = await taskRepository.findMany({
    where,
    take: limit + 1,
    orderBy,
    include: {
      client: {
        select: { id: true, fullname: true, isVip: true, badge: true }
      },
      _count: {
        select: { bids: true }
      }
    }
  });

  let nextCursor = null;
  if (tasks.length > limit) {
    tasks.pop(); // Remove the extra item
    nextCursor = tasks[tasks.length - 1].id;
  }

  // Phase 5: Task DNA Matching Engine Computation
  let processedTasks = tasks;
  
  if (userId) {
    // 1. Fetch user context
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { skills: true }
    });
    const learningPath = await prisma.learningPath.findUnique({
      where: { userId }
    });
    
    if (user) {
      const userSkills = user.skills || [];
      const strongSkills = learningPath?.strongSkills || [];
      
      // 2. Compute DNA Match score for each task
      processedTasks = tasks.map(task => {
        let dnaScore = 100; // Base score
        
        // Match category against user skills (+20)
        if (userSkills.includes(task.category)) {
          dnaScore += 20;
        }
        
        // Success history (+30 if category is in strongSkills)
        if (strongSkills.includes(task.category)) {
          dnaScore += 30;
        }
        
        // Competition Density (-10 if >10 bids)
        if (task._count.bids > 10) {
          dnaScore -= 10;
        }
        
        return {
          ...task,
          dnaScore
        };
      });
      
      // 3. Re-sort by DNA Score (Promoted tasks still stay on top)
      processedTasks.sort((a, b) => {
        const aIsPromoted = a.promotedUntil && new Date(a.promotedUntil) > new Date();
        const bIsPromoted = b.promotedUntil && new Date(b.promotedUntil) > new Date();
        
        if (aIsPromoted && !bIsPromoted) return -1;
        if (!aIsPromoted && bIsPromoted) return 1;
        
        return (b.dnaScore || 0) - (a.dnaScore || 0);
      });
    }
  }

  return {
    tasks: processedTasks,
    nextCursor
  };
}

async function _triggerTaskSideEffects(taskId, nextState, userId) {
  try {
    const io = getIO();
    io.to(`task_${taskId}`).emit('task_status_changed', { taskId, newStatus: nextState });
  } catch (err) {}

  try {
    const room = await chatRoomService.getOrCreateTaskRoom(userId, taskId);
    let msg = '';
    switch (nextState) {
      case TASK_STATUS.IN_PROGRESS: msg = "💼 Vazifa ishi boshlandi! Omad yor bo'lsin."; break;
      case TASK_STATUS.PREVIEW_PENDING: msg = "📦 Ish natijasi yuklandi! Mijozning ko'rib chiqishi kutilmoqda."; break;
      case TASK_STATUS.IN_REVIEW: msg = "✅ Natija mijozga manzur keldi, to'liq fayllar tekshirilmoqda."; break;
      case TASK_STATUS.COMPLETED: msg = "🎉 Vazifa muvaffaqiyatli yakunlandi! Hamkorlik uchun rahmat."; break;
      case TASK_STATUS.CANCELED: msg = "❌ Vazifa bekor qilindi."; break;
      case TASK_STATUS.DISPUTED: msg = "⚖️ Nizo (dispute) ochildi. Admin ko'rib chiqishi kutilmoqda."; break;
    }
    
    if (msg) {
      await chatService.sendSystemEvent(room.id, msg);
    }

    if (nextState === TASK_STATUS.COMPLETED || nextState === TASK_STATUS.CANCELED) {
      await taskChatSyncService.archiveTaskRoom(taskId);
    }
  } catch (err) {
    logger.error(`Side effects failed for task ${taskId}: ${err.message}`);
  }
}

/**
 * Internal helper to update state with validation
 */
async function _changeTaskState(taskId, nextState, expectedUserId, roleStr) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);

  // Authorize
  const isClient = task.clientId === expectedUserId;
  let isFreelancer = task.freelancerId === expectedUserId;
  
  if (!isFreelancer && task.isCoWorking) {
    const collab = await prisma.taskCollaborator.findUnique({
      where: { taskId_freelancerId: { taskId, freelancerId: expectedUserId } }
    });
    if (collab && collab.status === 'ACCEPTED') isFreelancer = true;
  }

  if (roleStr === 'CLIENT' && !isClient) throw new AppError('Siz mijoz emassiz', 403);
  if (roleStr === 'FREELANCER' && !isFreelancer) throw new AppError('Siz ijrochi emassiz', 403);
  if (roleStr === 'ANY_PARTICIPANT' && !isClient && !isFreelancer) {
    throw new AppError('Ruxsat yo\'q', 403);
  }

  validateTransition(task.status, nextState);

  const updateData = { status: nextState };
  const now = new Date();
  
  switch (nextState) {
    case TASK_STATUS.PREVIEW_PENDING: updateData.inReviewAt = now; break; // Re-use inReviewAt for preview timestamp
    case TASK_STATUS.IN_PROGRESS: updateData.inProgressAt = now; break;
    case TASK_STATUS.IN_REVIEW: updateData.inReviewAt = now; break;
    case TASK_STATUS.COMPLETED: updateData.completedAt = now; break;
    case TASK_STATUS.CANCELED: updateData.canceledAt = now; break;
  }

  // Optimistic concurrency control to prevent race conditions
  const updateResult = await prisma.task.updateMany({
    where: { id: taskId, status: task.status },
    data: updateData
  });

  if (updateResult.count === 0) {
    throw new AppError('Vazifa holati allaqachon o\'zgargan. Iltimos sahifani yangilang.', 409);
  }

  const updatedTask = await taskRepository.findUnique({ where: { id: taskId }, include: { client: true, freelancer: true } });

  await _triggerTaskSideEffects(taskId, nextState, expectedUserId);

  return { 
    updatedTask, 
    oldTask: task 
  };
}

async function startProgress(taskId, freelancerId) {
  const { updatedTask } = await _changeTaskState(taskId, TASK_STATUS.IN_PROGRESS, freelancerId, 'FREELANCER');
  return updatedTask;
}

/**
 * Freelancer submits protected preview delivery
 */
async function submitPreviewDelivery(taskId, freelancerId, { previewFileIds, fullFileIds, note }) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  
  let isFreelancer = task.freelancerId === freelancerId;
  if (!isFreelancer && task.isCoWorking) {
    const collab = await prisma.taskCollaborator.findUnique({
      where: { taskId_freelancerId: { taskId, freelancerId } }
    });
    if (collab && collab.status === 'ACCEPTED') isFreelancer = true;
  }
  
  if (!isFreelancer) throw new AppError('Ruxsat yo\'q', 403);
  
  validateTransition(task.status, TASK_STATUS.PREVIEW_PENDING);
  
  return prisma.$transaction(async (tx) => {
    // Upsert delivery record
    await tx.workDelivery.upsert({
      where: { taskId },
      create: { 
        taskId, 
        freelancerId, 
        previewFileIds: previewFileIds || [], 
        fullFileIds: fullFileIds || [], 
        previewNote: note 
      },
      update: { 
        previewFileIds: previewFileIds || [], 
        fullFileIds: fullFileIds || [], 
        previewNote: note,
        revisionCount: { increment: 1 }
      }
    });

    const updatedTask = await tx.task.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.PREVIEW_PENDING, inReviewAt: new Date() },
      include: { client: true, freelancer: true, delivery: true }
    });

    await _triggerTaskSideEffects(taskId, TASK_STATUS.PREVIEW_PENDING, freelancerId);

    return updatedTask;
  });
}

/**
 * Client approves the protected preview -> moves to IN_REVIEW
 */
async function approvePreview(taskId, clientId) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw new AppError('Vazifa topilmadi', 404);
    if (task.clientId !== clientId) throw new AppError('Siz mijoz emassiz', 403);

    validateTransition(task.status, TASK_STATUS.IN_REVIEW);

    await tx.workDelivery.updateMany({
      where: { taskId },
      data: { clientAcceptedAt: new Date() }
    });

    const updateResult = await tx.task.updateMany({
      where: { id: taskId, status: task.status },
      data: { status: TASK_STATUS.IN_REVIEW, inReviewAt: new Date() }
    });

    if (updateResult.count === 0) {
      throw new AppError('Vazifa holati allaqachon o\'zgargan. Iltimos sahifani yangilang.', 409);
    }

    const updatedTask = await tx.task.findUnique({
      where: { id: taskId },
      include: { client: true, freelancer: true, delivery: true }
    });

    await _triggerTaskSideEffects(taskId, TASK_STATUS.IN_REVIEW, clientId);

    return updatedTask;
  });
}

/**
 * Called after client submits their review to unlock full files
 */
async function revealFullDelivery(taskId, clientId) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);

  const delivery = await prisma.workDelivery.findUnique({ where: { taskId } });
  if (!delivery) throw new AppError('Yetkazib berish topilmadi', 404);
  if (delivery.fullRevealedAt) return delivery; // Already revealed
  
  // Verify review was submitted
  const review = await prisma.review.findFirst({
    where: { taskId, fromUserId: task.clientId }
  });
  if (!review) throw new AppError('Avval baho qoldiring', 400, 'REVIEW_REQUIRED');
  
  return prisma.workDelivery.update({
    where: { taskId },
    data: { fullRevealedAt: new Date() }
  });
}

/**
 * Get protected delivery files securely
 */
async function getDeliveryFiles(taskId, userId, type = 'preview') {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  
  const isClient = task.clientId === userId;
  let isFreelancer = task.freelancerId === userId;
  
  if (!isFreelancer && task.isCoWorking) {
    const collab = await prisma.taskCollaborator.findUnique({
      where: { taskId_freelancerId: { taskId, freelancerId: userId } }
    });
    if (collab && collab.status === 'ACCEPTED') isFreelancer = true;
  }

  if (!isClient && !isFreelancer) throw new AppError('Ruxsat yo\'q', 403);
  
  const delivery = await prisma.workDelivery.findUnique({ where: { taskId } });
  if (!delivery) throw new AppError('Hali yetkazib berilmagan', 404);
  
  if (type === 'full') {
    if (isClient && !delivery.fullRevealedAt) {
      throw new AppError('Avval baho qoldiring', 403, 'REVIEW_REQUIRED_FOR_FULL_ACCESS');
    }
  }
  
  return type === 'full' ? delivery.fullFileIds : delivery.previewFileIds;
}

async function acceptDelivery(taskId, clientId) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Siz mijoz emassiz', 403);

  validateTransition(task.status, TASK_STATUS.COMPLETED);

  const updatedTask = await prisma.$transaction(async (tx) => {
    // 1. Update Task Status
    const updateResult = await tx.task.updateMany({
      where: { id: taskId, status: task.status },
      data: { status: TASK_STATUS.COMPLETED, completedAt: new Date() }
    });

    if (updateResult.count === 0) {
      throw new AppError('Vazifa holati allaqachon o\'zgargan.', 409);
    }

    const t = await tx.task.findUnique({ 
      where: { id: taskId },
      include: { client: true, freelancer: true } 
    });

    // 2. Payout Logic
    const price = t.agreedPrice || 0;
    if (price > 0) {
      let payoutList = [];

      if (t.isCoWorking) {
        const collabs = await tx.taskCollaborator.findMany({
          where: { taskId, status: 'ACCEPTED' },
          include: { freelancer: true }
        });
        
        let totalDistributed = 0;
        collabs.forEach((c, index) => {
          let amount = (index === collabs.length - 1) 
            ? (price - totalDistributed) 
            : Math.floor(price * (c.sharePercent / 100));
          totalDistributed += amount;
          payoutList.push({ freelancer: c.freelancer, amount });
        });
      } else if (t.freelancerId) {
        const freelancer = await tx.user.findUnique({ where: { id: t.freelancerId } });
        if (freelancer) {
          payoutList.push({ freelancer, amount: price });
        }
      }

      for (const payout of payoutList) {
        if (!payout.freelancer || payout.amount <= 0) continue;

        // Escrow Release
        await tx.user.update({
          where: { id: payout.freelancer.id },
          data: { balance: { increment: payout.amount } }
        });

        await tx.transactionLog.create({
          data: {
            userId: payout.freelancer.id,
            taskId,
            amount: payout.amount,
            type: 'ESCROW_RELEASE',
            status: 'COMPLETED',
            notes: t.isCoWorking ? `Study Buddy ulushi (${payout.amount} UZS)` : 'Vazifa yakunlandi'
          }
        });

        // Referral Bonus
        if (payout.freelancer.referredBy) {
          const bonusAmount = Math.floor(payout.amount * 0.05);
          if (bonusAmount > 0) {
            await tx.user.update({
              where: { id: payout.freelancer.referredBy },
              data: { referralEarned: { increment: bonusAmount } }
            });
            await tx.transactionLog.create({
              data: {
                userId: payout.freelancer.referredBy,
                taskId,
                amount: bonusAmount,
                type: 'REFERRAL_BONUS',
                status: 'COMPLETED',
                notes: `${payout.freelancer.fullname} tomonidan bajarilgan vazifadan 5% bonus`
              }
            });
          }
        }
      }
    }
    return t;
  });

  // 3. Post-transaction side effects
  try {
    const io = getIO();
    io.to(`task_${taskId}`).emit('task_status_changed', { taskId, newStatus: TASK_STATUS.COMPLETED });
    
    const room = await chatRoomService.getOrCreateTaskRoom(clientId, taskId);
    await chatService.sendSystemEvent(room.id, "🎉 Vazifa muvaffaqiyatli yakunlandi! Hamkorlik uchun rahmat.");
    await taskChatSyncService.archiveTaskRoom(taskId);

    io.emit('platform_pulse', {
      event: 'TASK_COMPLETED',
      category: updatedTask.category,
      price: updatedTask.agreedPrice,
      timestamp: Date.now()
    });
  } catch (err) {
    logger.error(`Post-accept delivery error: ${err.message}`);
  }

  await notificationService.taskCompleted(updatedTask);
  
  return updatedTask;
}

async function requestRevision(taskId, clientId, note) {
  const { updatedTask } = await _changeTaskState(taskId, TASK_STATUS.IN_PROGRESS, clientId, 'CLIENT');
  await notificationService.revisionRequested(updatedTask, note);
  return updatedTask;
}

async function cancelTask(taskId, userId) {
  const { updatedTask } = await _changeTaskState(taskId, TASK_STATUS.CANCELED, userId, 'ANY_PARTICIPANT');
  return updatedTask;
}

async function openDispute(taskId, userId, reason, description, evidenceFileIds) {
  const task = await taskRepository.findUnique({ where: { id: taskId }, include: { client: true, freelancer: true, collaborators: true } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  
  const isClient = task.clientId === userId;
  const isFreelancer = task.freelancerId === userId;
  const isCollab = task.collaborators?.some(c => c.freelancerId === userId && c.status === 'ACCEPTED');
  
  if (!isClient && !isFreelancer && !isCollab) {
    throw new AppError('Ruxsat yo\'q', 403);
  }

  validateTransition(task.status, TASK_STATUS.DISPUTED);

  return prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.create({
      data: {
        taskId,
        openedByUserId: userId,
        reason,
        description,
        evidenceFileIds: evidenceFileIds || [],
        status: 'OPEN'
      }
    });

    const updatedTask = await tx.task.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.DISPUTED },
      include: { client: true, freelancer: true }
    });

    await _triggerTaskSideEffects(taskId, TASK_STATUS.DISPUTED, userId);

    await notificationService.disputeOpened(updatedTask, dispute);
    return { updatedTask, dispute };
  });
}

/**
 * Soft delete task (Client only)
 */
async function deleteTask(taskId, clientId) {
  const task = await taskRepository.findUnique({ where: { id: taskId } });
  
  if (!task) throw new AppError('Vazifa topilmadi', 404);
  if (task.clientId !== clientId) throw new AppError('Ruxsat yo\'q', 403);
  
  // Can only delete if OPEN or CANCELED
  if (task.status !== TASK_STATUS.OPEN && task.status !== TASK_STATUS.CANCELED) {
    throw new AppError('Bajarilayotgan vazifani o\'chirib bo\'lmaydi', 400);
  }

  return taskRepository.update({
    where: { id: taskId },
    data: { deletedAt: new Date() }
  });
}

// Phase 8: Peer Quality Shield
async function flagTask(taskId, userId, reason) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('Foydalanuvchi topilmadi', 404);

  // Check eligibility: Must be VIP or have rating > 4.5 (assuming a certain count)
  const isHighRated = user.ratingCount >= 5 && (user.ratingSum / user.ratingCount) >= 4.5;
  if (!user.isVip && !isHighRated) {
    throw new AppError('Sizda ushbu vazifani shikoyat qilish uchun yetarli reyting yoki VIP status yo\'q', 403);
  }

  // Check today's flag count for this user
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayFlagsCount = await prisma.taskFlag.count({
    where: {
      userId,
      createdAt: { gte: startOfDay }
    }
  });

  if (todayFlagsCount >= 5) {
    throw new AppError('Kunlik shikoyat qilish limiti tugadi (5/5)', 429);
  }

  const task = await taskRepository.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError('Vazifa topilmadi', 404);

  // Create flag
  try {
    await prisma.taskFlag.create({
      data: { taskId, userId, reason }
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw new AppError('Siz bu vazifaga allaqachon shikoyat qilgansiz', 400);
    }
    throw err;
  }

  // Update task flag count and check threshold
  const updatedTask = await taskRepository.update({
    where: { id: taskId },
    data: { flagCount: { increment: 1 } }
  });

  if (updatedTask.flagCount >= 3 && updatedTask.status === TASK_STATUS.OPEN) {
    // Hide or cancel task automatically
    await taskRepository.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.CANCELED, canceledAt: new Date() }
    });
    
    // Notify Admin (we can create a notification or log)
    logger.warn(`Task ${taskId} automatically canceled due to 3+ flags.`);
  }

  return { success: true, message: 'Shikoyat qabul qilindi' };
}

module.exports = {
  createTask,
  getTaskById,
  getMyTasks,
  listTasks,
  startProgress,
  submitPreviewDelivery,
  approvePreview,
  revealFullDelivery,
  getDeliveryFiles,
  acceptDelivery,
  requestRevision,
  cancelTask,
  openDispute,
  promoteTask,
  deleteTask,
  flagTask
};
