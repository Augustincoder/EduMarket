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
 */
function initSocket(httpServer) {
  // Import env config inside initSocket or define it above
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
    }
  });

  // Attach Redis adapter for cluster/multi-instance scale if connected
  if (pubClient.isOpen && subClient.isOpen) {
    io.adapter(createAdapter(pubClient, subClient));
    // No blind delete of 'online_users' to support multi-instance scale
  } else {
    logger.warn('Redis is not connected. Socket.io will use memory adapter.');
  }

  // Middleware for Authentication
  io.use(async (socket, next) => {
    try {
      // 1. Get token from handshake auth or query
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // 2. Verify Token
      const decoded = verifyToken(token);

      // 3. Check Blacklist
      if (isBlacklisted(decoded.jti)) {
        return next(new Error('Authentication error: Session ended'));
      }

      // 4. Verify User
      const userIdStr = String(decoded.userId);
      const user = await prisma.user.findUnique({
        where: { id: userIdStr },
        select: { id: true, isBanned: true }
      });

      if (!user) return next(new Error('Authentication error: User not found'));
      if (user.isBanned) return next(new Error('Authentication error: User banned'));

      // Attach user object to socket for later use
      socket.user = { ...decoded, userId: userIdStr };
      next();
    } catch (err) {
      next(new Error(`Authentication error: ${err.message}`));
    }
  });

  // Connection Handler
  io.on('connection', (socket) => {
    const userId = socket.user.userId;
    logger.info(`Socket connected: ${socket.id} (User: ${userId})`);

    // Join personal notification/event room
    socket.join(`user_${userId}`);

    // Track connection status
    handleUserConnect(userId, socket.id).catch(err => logger.error(`Error handling connect presence: ${err.message}`));

    // Client requests to join a chat room
    socket.on('join_chat_room', async (chatRoomId) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;
      try {
        // Validate that user belongs to this chat room
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
        logger.debug(`User ${socket.user.userId} joined room ${roomName}`);
      } catch (err) {
        logger.error(`join_chat_room error for user ${socket.user.userId}: ${err.message}`);
      }
    });

    socket.on('leave_chat_room', (chatRoomId) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;
      const roomName = `chat_${chatRoomId}`;
      socket.leave(roomName);
      if (socket.data.rooms) socket.data.rooms.delete(chatRoomId);
      logger.debug(`User ${socket.user.userId} left room ${roomName}`);
    });

    socket.on('typing', ({ chatRoomId }) => {
      if (!chatRoomId || typeof chatRoomId !== 'string') return;

      // Check if user joined the room (cached validation)
      if (!socket.data.rooms || !socket.data.rooms.has(chatRoomId)) return;

      const roomName = `chat_${chatRoomId}`;
      // Broadcast to everyone in the room except the sender
      socket.to(roomName).emit('user_typing', { chatRoomId, userId: socket.user.userId });
    });

    socket.on('subscribe_presence', async (userIds) => {
      if (!Array.isArray(userIds) || userIds.length === 0) return;

      try {
        // Optimization: Find all common chat rooms for the requester
        const myRooms = await prisma.chatParticipant.findMany({
          where: { userId: socket.user.userId },
          select: { chatRoomId: true }
        });
        const myRoomIds = myRooms.map(r => r.chatRoomId);

        // Find which of the requested users share at least one of these rooms
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
        logger.error(`Error in subscribe_presence: ${err.message}`);
      }
    });

    socket.on('unsubscribe_presence', (userIds) => {
      if (!Array.isArray(userIds)) return;
      userIds.forEach(id => {
        socket.leave(`presence_${id}`);
      });
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
      handleUserDisconnect(userId, socket.id).catch(err => logger.error(`Error handling disconnect presence: ${err.message}`));
    });
  });

  return io;
}

/**
 * Get initialized Socket.io instance
 */
function getIO() {
  if (!io) {
    throw new Error('Socket.io has not been initialized!');
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
      logger.error(`Redis getOnlineUsersSet error: ${err.message}`);
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
