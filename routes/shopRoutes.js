const router = require('express').Router();
const controller = require('../controllers/shopController');
const auth = require('../middleware/authenticateUser');
const { apiLimiter } = require('../middleware/rateLimiter');

router.get('/followed', auth, controller.getFollowedShops);
router.get('/:id/products', apiLimiter, controller.getSupplierProducts); // ✅ Added

module.exports = router;