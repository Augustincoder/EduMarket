const { AppError, asyncHandler } = require('./errorHandler');


/**
 * Middleware to restrict access to admins only.
 * Must be used AFTER requireAuth middleware.
 */
const requireAdmin = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new AppError('Foydalanuvchi ma\'lumotlari topilmadi', 401, 'UNAUTHORIZED');
  }

  if (req.user.role !== 'ADMIN') {
    throw new AppError('Sizda ushbu amalni bajarish uchun huquq yo\'q', 403, 'FORBIDDEN_NOT_ADMIN');
  }

  next();
});

module.exports = { requireAdmin };
