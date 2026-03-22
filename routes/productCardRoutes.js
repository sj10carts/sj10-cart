// routes/productCardRoutes.js
const express = require('express');
const router = express.Router();
const productCardController = require('../controllers/productCardController');

router.get('/', productCardController.getProductCards);

module.exports = router;