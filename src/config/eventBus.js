const Redis = require('ioredis');
const env = require('./env');
const logger = require('../utils/logger');

const redis = new Redis(env.REDIS_URL);

/**
 * Event Bus PoC using Redis Streams
 * Decouples services using asynchronous event patterns.
 */

/**
 * Publish an event to a stream
 */
async function publish(streamName, eventData) {
  try {
    const message = JSON.stringify({
      ...eventData,
      _timestamp: Date.now()
    });

    // XADD streamName * key value
    const messageId = await redis.xadd(streamName, '*', 'event', message);
    logger.debug(`Event published to ${streamName} [ID: ${messageId}]`);
    return messageId;
  } catch (err) {
    logger.error(`Failed to publish event to ${streamName}: ${err.message}`);
  }
}

/**
 * Basic Consumer setup for PoC
 */
async function createConsumerGroup(streamName, groupName) {
  try {
    // XGROUP CREATE streamName groupName $ MKSTREAM
    await redis.xgroup('CREATE', streamName, groupName, '$', 'MKSTREAM');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) {
      logger.error(`Failed to create consumer group: ${err.message}`);
    }
  }
}

/**
 * Sample Consumer function
 */
async function consume(streamName, groupName, consumerName, handler) {
  logger.info(`Starting consumer ${consumerName} for stream ${streamName}...`);
  
  while (true) {
    try {
      // XREADGROUP GROUP groupName consumerName BLOCK 0 COUNT 1 STREAMS streamName >
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'BLOCK', 0,
        'COUNT', 1,
        'STREAMS', streamName, '>'
      );

      if (result) {
        const [, messages] = result[0];
        for (const [id, [, value]] of messages) {
          const eventData = JSON.parse(value);
          
          try {
            await handler(eventData);
            // XACK streamName groupName id
            await redis.xack(streamName, groupName, id);
          } catch (handlerErr) {
            logger.error(`Handler error for event ${id}: ${handlerErr.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`Stream consumption error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000)); // Cool down
    }
  }
}

module.exports = {
  publish,
  createConsumerGroup,
  consume
};
