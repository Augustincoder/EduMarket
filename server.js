// server.js
// Application entry point.
//
// Responsibilities:
// 1. Load + validate environment variables (fail-fast)
// 2. Start HTTP server
// 3. Start background scheduler (cron jobs)
// 4. Graceful shutdown on SIGTERM/SIGINT (PM2 sends SIGINT on 'pm2 stop')
// 5. Catch uncaught exceptions / unhandled promise rejections

// ── STEP 1: Validate env BEFORE anything else ─────────────────────────────────
const env = require('./src/config/env');

// ── SENTRY INITIALIZATION ────────────────────────────────────────────────────
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.isProd ? 0.1 : 1.0,
    profilesSampleRate: 0.1,
    integrations: [nodeProfilingIntegration()],
  });
}

// ── STEP 2: Logger (needs env for log level) ──────────────────────────────────
const logger = require('./src/utils/logger');

// ── STEP 3: Initialize Telegram bot ───────────────────────────────────────────
const { getBot } = require('./src/config/bot');

// ── STEP 4: Create Express app ────────────────────────────────────────────────
const createApp = require('./src/app');

// ── STEP 5: Prisma (for graceful shutdown) ────────────────────────────────────
const prisma = require('./src/config/prisma');

// ── STEP 6: Redis & Socket.io ─────────────────────────────────────────────────
const { connectRedis } = require('./src/config/redis');
const { initSocket } = require('./src/config/socket');
const { initFirebase } = require('./src/config/firebase');

// ─── Uncaught error handlers ──────────────────────────────────────────────────
// These are last-resort guards. Ideally, all errors are caught by asyncHandler.
// We log + exit so PM2 can restart the process cleanly.

process.on('uncaughtException', (err) => {
  if (env.SENTRY_DSN) Sentry.captureException(err);
  
  logger.error({
    event: 'UNCAUGHT_EXCEPTION',
    message: err.message,
    stack: err.stack,
  });
  
  // Flush Sentry logs, then exit
  if (env.SENTRY_DSN) {
    Sentry.close(2000).then(() => process.exit(1));
  } else {
    setTimeout(() => process.exit(1), 500);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  if (env.SENTRY_DSN) Sentry.captureException(reason);

  logger.error({
    event: 'UNHANDLED_REJECTION',
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: String(promise),
  });
  
  // Do NOT exit here in production — just log.
  // Unhandled rejections in notification/scheduler are non-critical.
  if (env.isDev) {
    if (env.SENTRY_DSN) {
      Sentry.close(2000).then(() => process.exit(1));
    } else {
      process.exit(1); // Strict in development to catch bugs early
    }
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // Connect to Redis for Pub/Sub
    await connectRedis();

    // Initialize Firebase
    initFirebase();

    // Initialize bot (lazy — won't crash if Telegram is unreachable)
    getBot();

    // Run database migrations for legacy chat data
    const runChatMigration = require('./src/utils/migrateChats');
    await runChatMigration();

    const app = createApp();
    
    // Create HTTP Server from Express App
    const http = require('http');
    const httpServer = http.createServer(app);

    // Attach Socket.io to HTTP Server
    // IMPORTANT: initSocket is called AFTER connectRedis so the Redis adapter
    // is guaranteed to be set up with open pub/sub clients
    initSocket(httpServer);

    const server = httpServer.listen(env.PORT, () => {
      logger.info(`EduMarket backend ishga tushdi — port ${env.PORT} (${env.NODE_ENV})`);
    });

    // Initialize background queue workers
    try {
      const { initWorkers } = require('./src/config/queue');
      initWorkers();
    } catch (err) {
      logger.warn(`Queue yuklanmadi: ${err.message}`);
    }

    // Start cron scheduler (loads lazily — won't crash if Prisma not ready)
    try {
      const { initScheduler } = require('./src/utils/scheduler');
      initScheduler();
    } catch (err) {
      logger.warn(`Scheduler yuklanmadi: ${err.message}`);
    }

    // ─── Graceful shutdown ─────────────────────────────────────────────────
    // PM2 sends SIGINT on 'pm2 stop' / 'pm2 reload'
    // Docker sends SIGTERM on container stop
    const shutdown = async (signal) => {
      logger.info(`${signal} signali qabul qilindi. Graceful shutdown boshlanmoqda...`);

      // 1. Stop accepting new connections
      server.close(async () => {
        logger.info('HTTP server yopildi (yangi ulanishlar qabul qilinmayapti).');

        try {
          // 2. Disconnect Prisma (closes DB connection pool)
          await prisma.$disconnect();
          logger.info('PostgreSQL ulanishi yopildi.');
        } catch (err) {
          logger.error(`Prisma disconnect xatosi: ${err.message}`);
        }

        logger.info('Graceful shutdown yakunlandi.');
        process.exit(0);
      });

      // Force exit if graceful shutdown takes too long (5s)
      setTimeout(() => {
        logger.error('Graceful shutdown limiti oshdi. Majburiy chiqish.');
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error(`Server ishga tushmadi: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

start();
