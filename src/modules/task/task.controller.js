const taskService = require('./task.service');
const { clearCache } = require('../../middleware/cache');

async function createTask(req, res) {
  const clientId = req.user.id;
  const task = await taskService.createTask(clientId, req.body);
  await clearCache('/api/v1/tasks*');
  res.status(201).json({ success: true, message: 'Vazifa muvaffaqiyatli yaratildi', data: task });
}

async function listTasks(req, res) {
  const result = await taskService.listTasks(req.query, req.user?.id);
  res.json({ success: true, data: result });
}

async function getMyTasks(req, res) {
  const filters = {
    role: req.query.role,
    status: req.query.status
  };
  const tasks = await taskService.getMyTasks(req.user.id, filters);
  res.json({ success: true, data: tasks });
}

async function getTask(req, res) {
  const taskId = req.params.id;
  if (!taskId) return res.status(400).json({ success: false, message: 'Yaroqsiz ID' });
  const task = await taskService.getTaskById(taskId);
  res.json({ success: true, data: task });
}

async function startProgress(req, res) {
  const taskId = req.params.id;
  const task = await taskService.startProgress(taskId, req.user.id);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Vazifa bajarilishi boshlandi', data: task });
}

async function promoteTask(req, res) {
  const taskId = req.params.id;
  const { packageType } = req.body;
  const task = await taskService.promoteTask(taskId, req.user.id, packageType);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Vazifa muvaffaqiyatli ko\'tarildi', data: task });
}

async function submitPreviewDelivery(req, res) {
  const taskId = req.params.id;
  const task = await taskService.submitPreviewDelivery(taskId, req.user.id, req.body);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Himoyalangan ko\'rinish yuklandi', data: task });
}

async function approvePreview(req, res) {
  const taskId = req.params.id;
  const task = await taskService.approvePreview(taskId, req.user.id);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Ko\'rinish tasdiqlandi. Baho qoldiring.', data: task });
}

async function revealFullDelivery(req, res) {
  const taskId = req.params.id;
  const delivery = await taskService.revealFullDelivery(taskId, req.user.id);
  res.json({ success: true, message: 'To\'liq fayllar ochildi', data: delivery });
}

async function getDeliveryFiles(req, res) {
  const taskId = req.params.id;
  const type = req.query.type || 'preview';
  const files = await taskService.getDeliveryFiles(taskId, req.user.id, type);
  res.json({ success: true, data: files });
}

async function acceptTask(req, res) {
  const taskId = req.params.id;
  const task = await taskService.acceptDelivery(taskId, req.user.id);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Vazifa qabul qilindi. To\'lov o\'tkaziladi.', data: task });
}

async function requestRevision(req, res) {
  const taskId = req.params.id;
  const { note } = req.body;
  const task = await taskService.requestRevision(taskId, req.user.id, note);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Vazifa qayta ishlashga qaytarildi', data: task });
}

async function cancelTask(req, res) {
  const taskId = req.params.id;
  const task = await taskService.cancelTask(taskId, req.user.id);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Vazifa bekor qilindi', data: task });
}

async function openDispute(req, res) {
  const taskId = req.params.id;
  const { reason, description, evidenceFileIds } = req.body;
  if (!reason || typeof reason !== 'string') return res.status(400).json({ success: false, message: 'Nizo sababini to\'g\'ri kiriting' });
  if (!description || typeof description !== 'string') return res.status(400).json({ success: false, message: 'Nizo izohini to\'g\'ri kiriting' });
  if (description.trim().length < 50) return res.status(400).json({ success: false, message: 'Izoh kamida 50 ta belgidan iborat bo\'lishi kerak' });
  const result = await taskService.openDispute(taskId, req.user.id, reason, description.trim(), evidenceFileIds);
  await clearCache(`/api/v1/tasks*`);
  res.json({ success: true, message: 'Nizo ochildi', data: result.updatedTask });
}

async function deleteTask(req, res) {
  const taskId = req.params.id;
  await taskService.deleteTask(taskId, req.user.id);
  await clearCache('/api/v1/tasks*');
  res.json({ success: true, message: 'Vazifa o\'chirildi' });
}

async function flagTask(req, res) {
  const taskId = req.params.id;
  const { reason } = req.body;
  const result = await taskService.flagTask(taskId, req.user.id, reason);
  await clearCache('/api/v1/tasks*');
  res.json({ success: true, message: result.message });
}

module.exports = {
  createTask,
  listTasks,
  getMyTasks,
  getTask,
  startProgress,
  submitPreviewDelivery,
  approvePreview,
  revealFullDelivery,
  getDeliveryFiles,
  acceptTask,
  requestRevision,
  cancelTask,
  openDispute,
  promoteTask,
  deleteTask,
  flagTask
};
