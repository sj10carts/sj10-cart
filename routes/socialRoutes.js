const router = require('express').Router();
const controller = require('../controllers/socialController');
const auth = require('../middleware/authenticateUser');
const { followLimiter } = require('../middleware/rateLimiter');

router.get('/follow/status/:id', auth, controller.getFollowStatus);
router.post('/follow/:id', auth, followLimiter, controller.toggleFollow);

module.exports = router;