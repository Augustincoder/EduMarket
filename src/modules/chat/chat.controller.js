const chatService = require('./chat.service');
const chatRoomService = require('./chat-room.service');

/** =========================================
 *  ROOM & INVITE CONTROLLERS (BOSQICH 1 va 2)
 *  ========================================= */

async function getOrCreateDirectChat(req, res) {
  const { targetUserId } = req.body;
  const userId = req.user.id;
  const room = await chatRoomService.getOrCreateDirectChat(userId, targetUserId);
  res.json({ success: true, data: room });
}

async function getOrCreateTaskRoom(req, res) {
  const { taskId } = req.params;
  const userId = req.user.id;
  const room = await chatRoomService.getOrCreateTaskRoom(userId, taskId);
  res.json({ success: true, data: room });
}

async function createCustomGroup(req, res) {
  const { name, avatarUrl } = req.body;
  const userId = req.user.id;
  const room = await chatRoomService.createCustomGroup(userId, name, avatarUrl);
  res.status(201).json({ success: true, data: room });
}

async function updateGroupSettings(req, res) {
  const { chatRoomId } = req.params;
  const { name, avatarUrl } = req.body;
  const userId = req.user.id;
  const room = await chatRoomService.updateGroupSettings(chatRoomId, userId, name, avatarUrl);
  res.json({ success: true, data: room });
}

async function removeParticipant(req, res) {
  const { chatRoomId, targetUserId } = req.params;
  const userId = req.user.id;
  await chatRoomService.removeParticipant(chatRoomId, userId, targetUserId);
  res.json({ success: true, data: null });
}

async function leaveGroup(req, res) {
  const { chatRoomId } = req.params;
  const userId = req.user.id;
  await chatRoomService.leaveGroup(chatRoomId, userId);
  res.json({ success: true, data: null });
}

async function searchUsersForInvite(req, res) {
  const { query } = req.query;
  const { chatRoomId } = req.params;
  const users = await chatRoomService.searchUsersForInvite(query, chatRoomId);
  res.json({ success: true, data: users });
}

async function sendInvite(req, res) {
  const { chatRoomId } = req.params;
  const { targetUserId } = req.body;
  const inviterId = req.user.id;
  const invite = await chatRoomService.sendInvite(chatRoomId, inviterId, targetUserId);
  res.status(201).json({ success: true, data: invite });
}

async function getMyInvites(req, res) {
  const userId = req.user.id;
  const invites = await chatRoomService.getMyInvites(userId);
  res.json({ success: true, data: invites });
}

async function acceptInvite(req, res) {
  const { inviteId } = req.params;
  const userId = req.user.id;
  await chatRoomService.acceptInvite(inviteId, userId);

  res.json({ success: true, data: null });
}

async function rejectInvite(req, res) {
  const { inviteId } = req.params;
  const userId = req.user.id;
  await chatRoomService.rejectInvite(inviteId, userId);
  res.json({ success: true, data: null });
}

/** =========================================
 *  MODERATION CONTROLLERS (BOSQICH 2 qo'shimcha)
 *  ========================================= */

async function updateParticipantRole(req, res) {
  const { chatRoomId, targetUserId } = req.params;
  const { role } = req.body;
  const userId = req.user.id;
  const result = await chatRoomService.updateParticipantRole(chatRoomId, userId, targetUserId, role);
  res.json({ success: true, data: result });
}

async function muteParticipant(req, res) {
  const { chatRoomId, targetUserId } = req.params;
  const { durationMinutes } = req.body;
  const userId = req.user.id;
  const result = await chatRoomService.muteParticipant(chatRoomId, userId, targetUserId, durationMinutes || 60);
  res.json({ success: true, data: result });
}

async function banUserFromRoom(req, res) {
  const { chatRoomId, targetUserId } = req.params;
  const userId = req.user.id;
  const result = await chatRoomService.banUserFromRoom(chatRoomId, userId, targetUserId);
  res.json({ success: true, data: result });
}

async function updateAdvancedGroupSettings(req, res) {
  const { chatRoomId } = req.params;
  const userId = req.user.id;
  const result = await chatRoomService.updateAdvancedGroupSettings(chatRoomId, userId, req.body);
  res.json({ success: true, data: result });
}

/** =========================================
 *  MESSAGING CONTROLLERS (BOSQICH 3)
 *  ========================================= */

async function sendMessage(req, res) {
  const { chatRoomId } = req.params;
  const senderId = req.user.id;
  const message = await chatService.sendMessage(chatRoomId, senderId, req.body);
  res.status(201).json({ success: true, data: message });
}

async function getMessages(req, res) {
  const { chatRoomId } = req.params;
  const userId = req.user.id;
  const cursor = req.query.cursor || undefined;
  let limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  if (limit > 100) limit = 100; // Prevent DB overload

  const result = await chatService.getMessages(chatRoomId, userId, cursor, limit);
  res.json({ success: true, data: result });
}

async function pinMessage(req, res) {
  const { chatRoomId, messageId } = req.params;
  const userId = req.user.id;
  const room = await chatService.pinMessage(chatRoomId, userId, messageId);
  res.json({ success: true, data: room });
}

async function getConversations(req, res) {
  const userId = req.user.id;
  const conversations = await chatService.getConversations(userId);
  res.json({ success: true, data: conversations });
}

async function editMessage(req, res) {
  const { messageId } = req.params;
  const userId = req.user.id;
  const { content } = req.body;
  const updatedMessage = await chatService.editMessage(messageId, userId, content);
  res.json({ success: true, data: updatedMessage });
}

async function deleteMessage(req, res) {
  const { messageId } = req.params;
  const userId = req.user.id;
  const deletedMessage = await chatService.deleteMessage(messageId, userId);
  res.json({ success: true, data: deletedMessage });
}

async function toggleReaction(req, res) {
  const { messageId } = req.params;
  const userId = req.user.id;
  const { icon } = req.body;
  const result = await chatService.toggleReaction(messageId, userId, icon);
  res.json({ success: true, data: result });
}

async function markAsRead(req, res) {
  const { chatRoomId } = req.params;
  const userId = req.user.id;
  const result = await chatService.markAsRead(chatRoomId, userId);
  res.json({ success: true, data: result });
}

async function searchGlobalMessages(req, res) {
  const { query } = req.query;
  const userId = req.user.id;
  const results = await chatService.searchGlobalMessages(userId, query);
  res.json({ success: true, data: results });
}

async function getChatRoomInfo(req, res) {
  const { chatRoomId } = req.params;
  const userId = req.user.id;
  const info = await chatRoomService.getChatRoomInfo(chatRoomId, userId);
  res.json({ success: true, data: info });
}

module.exports = {
  // Room
  getOrCreateDirectChat,
  getOrCreateTaskRoom,
  createCustomGroup,
  updateGroupSettings,
  removeParticipant,
  leaveGroup,
  getChatRoomInfo,
  // Invites
  searchUsersForInvite,
  sendInvite,
  getMyInvites,
  acceptInvite,
  rejectInvite,
  updateParticipantRole,
  muteParticipant,
  banUserFromRoom,
  updateAdvancedGroupSettings,
  // Messaging
  sendMessage,
  getMessages,
  pinMessage,
  getConversations,
  editMessage,
  deleteMessage,
  toggleReaction,
  markAsRead,
  searchGlobalMessages
};
