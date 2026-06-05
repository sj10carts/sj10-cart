// routes/markazRoutes.js (Carts Backend)
const express = require('express');
const router = express.Router();
const markazController = require('../controllers/markazController');

// 🟢 AUTH BYPASSED FOR FAST COOLDOWN-FREE SCRAPING (JUST LIKE SERVER 2)

router.post('/scrape', markazController.scrapeMarkaz);
router.post('/save', markazController.saveProduct);
router.get('/team', markazController.getTeam);
router.post('/bulk-save', markazController.bulkSaveProducts);
router.get('/sync-counters', markazController.syncAllSuppliersProductCounts);

module.exports = router;