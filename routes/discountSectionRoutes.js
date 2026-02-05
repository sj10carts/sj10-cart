const express = require('express');
const router = express.Router();
const controller = require('../controllers/discountSectionController');

router.get('/', controller.getActiveDiscountSections);
router.get('/:id', controller.getDiscountDetails);     // ✅ NEW: Single Page Route

module.exports = router;