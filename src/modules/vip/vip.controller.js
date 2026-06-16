const vipService = require('./vip.service');
const { VIP_PACKAGES } = require('./vip.packages');
const { asyncHandler } = require('../../middleware/errorHandler');

/**
 * Get available VIP packages
 */
function getPackages(req, res) {
  res.json({
    success: true,
    data: Object.values(VIP_PACKAGES)
  });
}

/**
 * Submit VIP payment receipt
 */
async function submitPayment(req, res) {
  const userId = req.user.id;
  
  const payment = await vipService.createVipRequest(userId, req.body);
  
  res.status(201).json({
    success: true,
    message: 'To\'lov so\'rovi qabul qilindi. Tez orada ko\'rib chiqiladi.',
    data: payment
  });
}

/**
 * Get user's VIP status
 */
async function getStatus(req, res) {
  const userId = req.user.id;
  const status = await vipService.getVipStatus(userId);
  
  res.json({
    success: true,
    data: status
  });
}

module.exports = {
  getPackages,
  submitPayment,
  getStatus
};
