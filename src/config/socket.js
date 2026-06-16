const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { pubClient, subClient } = require('./redis');
const { verifyToken } = require('../utils/jwt');
const { isBlacklisted } = require('../utils/tokenBlacklist');
const logger = require('../utils/logger');
const prisma = require('./prisma');

let io;

// Active user socket connections map (for local memory fallback)
const localConnections = new Map();

/**
 * Handle user connection tracking
 */
async function handleUserConnect(userId, socketId) {
  if (!localConnections.has(userId)) {
    localConnections.set(userId, new Set());
  }
  const isFirstLocal = localConnections.get(userId).size === 0;
  localConnections.get(userId).add(socketId);

  let isFirstOverall = isFirstLocal;
  if (pubClient.isOpen) {
    try {
      await pubClient.sAdd(`user:sockets:${userId}`, socketId);
      await pubClient.expire(`user:sockets:${userId}`, 86400); // 24h safety TTL
      
      const added = await pubClient.sAdd('online_users', userId);
      isFirstOverall = added > 0;
    } catch (err) {
      logger.error(`Redis presence error on connect for user ${userId}: ${err.message}`);
    }
  }

  if (isFirstOverall && io) {
    logger.debug(`User ${userId} is now online`);
    io.to(`presence_${userId}`).emit('user_status_changed', { userId, isOnline: true });
  }
}

/**
 * Handle user disconnection tracking
 */
async function handleUserDisconnect(userId, socketId) {
  const userSockets = localConnections.get(userId);
  if (userSockets) {
    userSockets.delete(socketId);
    if (userSockets.size === 0) {
      localConnections.delete(userId);
    }
  }

  let isLastOverall = !localConnections.has(userId);
  if (pubClient.isOpen) {
    try {
      await pubClient.sRem(`user:sockets:${userId}`, socketId);
      const remaining = await pubClient.sCard(`user:sockets:${userId}`);
      if (remaining === 0) {
        await pubClient.sRem('online_users', userId);
        isLastOverall = true;
      } else {
        isLastOverall = false;
      }
    } catch (err) {
      logger.error(`Redis presence error on disconnect for user ${userId}: ${err.message}`);
    }
  }

  if (isLastOverall && io) {
    logger.debug(`User ${userId} is now offline`);
    io.to(`presence_${userId}`).emit('user_status_changed', { userId, isOnline: false });
  }
}

/**
 * Check if a user is online (checks local cache and Redis fallback)
 */
async function isUserOnline(userId) {
  if (localConnections.has(userId) && localConnections.get(userId).size > 0) {
    return true;
  }
  if (pubClient.isOpen) {
    try {
      const isMember = await pubClient.sIsMember('online_users', userId);
      return !!isMember;
    } catch (err) {
      logger.error(`Redis isUserOnline error for user ${userId}: ${err.message}`);
    }
  }
  return false;
}

/**
 * Initialize Socket.io Server and attach to HTTP server
 * MUST be called AFTER connectRedis() so pubClient/subClient are open
 */
function initSocket(httpServer) {
  const env = require('../config/env');
  const ALWAYS_ALLOWED = [
    'https://web.telegram.org',
    'https://telegram.org',
    'https://webk.telegram.org',
    'https://webz.telegram.org',
  ];
  const allowedOrigins = [
    ...ALWAYS_ALLOWED,
    ...env.ALLOWED_ORIGINS,
    ...(env.isDev ? ['http://localhost:5173', 'http://localhost:3000'] : []),
  ];

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    },
    // Allow both transports — Render supports websockets
    transports: ['websocket', 'polling'],
    // Ping/pong to detect dead connections fast
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ─── Redis Adapter ───────────────────────────────────────────────────────────
  // Since initSocket is called after connectRedis(), clients should be open.
  // If Redis is not available we fall back gracefully to memory adapter.
  if (pubClient.isOpen && subClient.isOpen) {
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.io Redis adapter ulandi (multi-instance sync faol)');
  } else {
    logger.warn('Redis ulanmagan. Socket.io xotira adapteri bilan ishlaydi (single-instance only).');
  }

  // ─── Middleware: Authentication ──────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = verifyToken(token);

      if (isBlacklisted(decoded.jti)) {
        return next(new Error('Authentication error: Session ended'));
      }

      const userIdStr = String(decoded.userId);
      const user = await prisma.user.findUnique({
        where: { id: userIdStr },
        select: { id: true, isBanned: true }
      });

      if (!user) return next(new Error('Authentication error: User not found'));
      if (user.isBanned) return next(new Error('Authentication error: User banned'));

      socket.user = { ...decoded, userId: userIdStr };
      next();
    } catch (err) {
      next(new Error(`Authentication error: ${err.message}`));
    }
  });

  // ─── Connection Handler ──────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.user.userId;
    logger.info(`Socket ulandi: ${socket.id} (Foydalanuvchi: ${userId})`);

    // Join personal notification/event room
    socket.join(`user_${userId}`);

    // Track connection status
    handleUserConnect(userId, socket.id).catch(err =>
      logger.error(`Ulanish holati xatosi: ${err.message}`)
    );

    // ─── join_chat_room ────────────────────────────────────────────────────────
    socket.on('join_chat_room', async (chatRoomId) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;
      try {
        const participant = await prisma.chatParticipant.findUnique({
          where: { chatRoomId_userId: { chatRoomId, userId: socket.user.userId } }
        });

        if (!participant) {
          socket.emit('error', 'Bu chatga kirish ruxsati yo\'q');
          return;
        }

        const roomName = `chat_${chatRoomId}`;
        socket.join(roomName);
        if (!socket.data.rooms) socket.data.rooms = new Set();
        socket.data.rooms.add(chatRoomId);
        logger.debug(`Foydalanuvchi ${socket.user.userId} chat_${chatRoomId} xonasiga qo'shildi`);
      } catch (err) {
        logger.error(`join_chat_room xatosi (${socket.user.userId}): ${err.message}`);
      }
    });

    // ─── leave_chat_room ───────────────────────────────────────────────────────
    socket.on('leave_chat_room', (chatRoomId) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;
      const roomName = `chat_${chatRoomId}`;
      socket.leave(roomName);
      if (socket.data.rooms) socket.data.rooms.delete(chatRoomId);
      logger.debug(`Foydalanuvchi ${socket.user.userId} chat_${chatRoomId} xonasidan chiqdi`);
    });

    // ─── typing ───────────────────────────────────────────────────────────────
    // FIX: Removed strict room membership check — user may not have called join_chat_room
    // yet (e.g., after reconnect) but they're still a valid participant.
    // Instead we do a lightweight DB check only if not in room set.
    socket.on('typing', async ({ chatRoomId }) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;

      // Fast path: user already in room set
      if (socket.data.rooms && socket.data.rooms.has(chatRoomId)) {
        socket.to(`chat_${chatRoomId}`).emit('user_typing', { chatRoomId, userId: socket.user.userId });
        return;
      }

      // Slow path: verify participation in DB then auto-join
      try {
        const participant = await prisma.chatParticipant.findUnique({
          where: { chatRoomId_userId: { chatRoomId, userId: socket.user.userId } }
        });
        if (!participant) return;

        // Auto-join for future events
        socket.join(`chat_${chatRoomId}`);
        if (!socket.data.rooms) socket.data.rooms = new Set();
        socket.data.rooms.add(chatRoomId);

        socket.to(`chat_${chatRoomId}`).emit('user_typing', { chatRoomId, userId: socket.user.userId });
      } catch (err) {
        logger.error(`typing check xatosi: ${err.message}`);
      }
    });

    // ─── subscribe_presence ───────────────────────────────────────────────────
    socket.on('subscribe_presence', async (userIds) => {
      if (!Array.isArray(userIds) || userIds.length === 0) return;

      try {
        const myRooms = await prisma.chatParticipant.findMany({
          where: { userId: socket.user.userId },
          select: { chatRoomId: true }
        });
        const myRoomIds = myRooms.map(r => r.chatRoomId);

        const allowedPartners = await prisma.chatParticipant.findMany({
          where: {
            chatRoomId: { in: myRoomIds },
            userId: { in: userIds }
          },
          select: { userId: true }
        });

        const allowedUserIds = new Set(allowedPartners.map(p => p.userId));

        allowedUserIds.forEach(id => {
          socket.join(`presence_${id}`);
        });
      } catch (err) {
        logger.error(`subscribe_presence xatosi: ${err.message}`);
      }
    });

    // ─── unsubscribe_presence ─────────────────────────────────────────────────
    socket.on('unsubscribe_presence', (userIds) => {
      if (!Array.isArray(userIds)) return;
      userIds.forEach(id => {
        socket.leave(`presence_${id}`);
      });
    });

    // ─── disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      logger.info(`Socket uzildi: ${socket.id} (sabab: ${reason})`);
      handleUserDisconnect(userId, socket.id).catch(err =>
        logger.error(`Uzilish holati xatosi: ${err.message}`)
      );
    });
  });

  return io;
}

/**
 * Get initialized Socket.io instance
 */
function getIO() {
  if (!io) {
    throw new Error('Socket.io ishga tushurilmagan!');
  }
  return io;
}

/**
 * Get all online users as a Set (checks local and Redis)
 */
async function getOnlineUsersSet() {
  const onlineUsers = new Set();
  
  if (pubClient.isOpen) {
    try {
      const members = await pubClient.sMembers('online_users');
      members.forEach(id => onlineUsers.add(id));
    } catch (err) {
      logger.error(`Redis getOnlineUsersSet xatosi: ${err.message}`);
    }
  } else {
    for (const userId of localConnections.keys()) {
      onlineUsers.add(userId);
    }
  }
  
  return onlineUsers;
}

module.exports = {
  initSocket,
  getIO,
  isUserOnline,
  getOnlineUsersSet
};
