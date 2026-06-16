const { createClient } = require('redis');
const logger = require('../utils/logger');
const env = require('./env');

// Using default redis connection locally (localhost:6379)
// In production, configure REDIS_URL in .env
const redisOptions = env.REDIS_URL ? {
  url: env.REDIS_URL,
  socket: {
    tls: env.REDIS_URL.startsWith('rediss://'),
    rejectUnauthorized: false // Helps with self-signed certs often used in managed DBs
  }
} : undefined;

const pubClient = createClient(redisOptions);
const subClient = pubClient.duplicate();

async function connectRedis() {
  try {
    await Promise.all([
      pubClient.connect(),
      subClient.connect()
    ]);
    logger.info(`Redis pub/sub clients ulangan (${env.REDIS_URL})`);
  } catch (err) {
    logger.error(`Redis ulanishida xatolik: ${err.message}`);
    // Non-fatal if Redis is down, but socket.io won't sync across instances
  }
}

pubClient.on('error', (err) => logger.error(`Redis Pub Client Error: ${err.message}`));
subClient.on('error', (err) => logger.error(`Redis Sub Client Error: ${err.message}`));

module.exports = {
  pubClient,
  subClient,
  connectRedis
};
