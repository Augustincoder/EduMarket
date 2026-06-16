const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const env = require('./env');
const logger = require('../utils/logger');

const isRedisTls = env.REDIS_URL && env.REDIS_URL.startsWith('rediss://');

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  ...(isRedisTls ? { tls: { rejectUnauthorized: false } } : {}),
});

const chatQueue = new Queue('chat_messages', { 
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

async function initWorkers() {

  const notificationService = require('../modules/notification/notification.service');
  const { isUserOnline } = require('./socket');

  const worker = new Worker('chat_messages', async job => {
    if (job.name === 'process_message_side_effects') {
      const { participants, chatRoomId, senderId, senderName } = job.data;
      
      if (!participants || !Array.isArray(participants)) return;

      // Filter offline participants to notify
      const offlineRecipientIds = [];
      
      for (const p of participants) {
        if (p.userId === senderId) continue;
        
        try {
          const isOnline = await isUserOnline(p.userId);
          if (!isOnline) {
            offlineRecipientIds.push(p.userId);
          }
        } catch (err) {
          logger.error(`Error checking online status for user ${p.userId}: ${err.message}`);
        }
      }

      if (offlineRecipientIds.length > 0) {
        await notificationService.notifyChatMessageBulk(offlineRecipientIds, senderName, chatRoomId);
      }
    }
  }, { 
    connection,
    concurrency: 5 // Process 5 jobs simultaneously
  });

  worker.on('completed', job => {
    logger.debug(`Job ${job.id} completed!`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job.id} failed with error ${err.message}`);
  });
}

module.exports = {
  chatQueue,
  initWorkers
};
