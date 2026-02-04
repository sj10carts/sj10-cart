// NEW FILE: cart-backend/api/routes/exploreRoutes.js

const express = require('express');
const router = express.Router();
const exploreController = require('../controllers/exploreController');

// Defines the GET /api/explore endpoint
router.get('/', exploreController.getExploreProducts);

module.exports = router;