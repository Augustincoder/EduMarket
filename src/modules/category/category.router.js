const express = require('express');
const categoryController = require('./category.controller');
const categorySchema = require('./category.schema');

const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/adminOnly');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

// Public route for frontend
router.get('/', asyncHandler(categoryController.getPublicCategories));

// Protected routes for ADMIN
router.use(requireAuth);
router.use(requireAdmin);

router.route('/admin')
  .get(asyncHandler(categoryController.getAdminCategories))
  .post(validate(categorySchema.createCategorySchema), asyncHandler(categoryController.createCategory));

router.route('/admin/:id')
  .patch(validate(categorySchema.updateCategorySchema), asyncHandler(categoryController.updateCategory))
  .delete(asyncHandler(categoryController.deleteCategory));

router.patch('/admin/:id/toggle', asyncHandler(categoryController.toggleCategory));

module.exports = router;
