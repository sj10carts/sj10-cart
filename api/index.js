// C:\Users\AounAbbas\Desktop\sj cart git\api\index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors'); // 🟢 Robust CORS is enabled now
const compression = require('compression');

// Routes Import
const cartRoutes = require('../routes/cartRoutes');
const exploreRoutes = require('../routes/exploreRoutes'); 
const shopRoutes = require('../routes/shopRoutes'); 
const discountSectionRoutes = require('../routes/discountSectionRoutes'); 
const productCardRoutes = require('../routes/productCardRoutes'); 
const markazRoutes = require('../routes/markazRoutes'); 

const app = express();

// =========================================================================
// 🚀 1. ROBUST CORS CONFIGURATION (Allows Auth Headers & Credentials)
// =========================================================================
app.use(cors({
    origin: true, // Mirrors requesting origin, fully compatible with credentials
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-api-key']
}));

// Increase JSON payload limits for heavy bulk images arrays
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(compression());

// =========================================================================
// 🚀 2. ROUTES MOUNTING
// =========================================================================
// Mount Scraper on top to bypass any customer restrictions
app.use('/api/markaz', markazRoutes);

app.use('/api/cart', cartRoutes);
app.use('/api/explore', exploreRoutes); 
app.use('/api/shops', shopRoutes); 
app.use('/api/discount-sections', discountSectionRoutes); 
app.use('/api/products/feed-cards', productCardRoutes); 

app.get('/', (req, res) => {
    res.json({ status: "SJ10 Cart Service is Running 🛒" });
});

module.exports = app;

// --- RUN LOCALLY ---
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 4005; // 🟢 Set default port to 4005
  app.listen(PORT, () => {
    console.log(`🛒 Cart Service running locally on http://localhost:${PORT}`);
  });
}