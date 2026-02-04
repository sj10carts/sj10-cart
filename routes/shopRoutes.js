// api/routes/shopRoutes.js

const router = require('express').Router();
const controller = require('../controllers/shopController');
const auth = require('../middleware/authenticateUser');

// Protected route to get followed shops
router.get('/followed', auth, controller.getFollowedShops);

module.exports = router;
