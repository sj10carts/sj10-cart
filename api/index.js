require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cartRoutes = require('../routes/cartRoutes');
const exploreRoutes = require('../routes/exploreRoutes'); // ✅ ADD THIS LINE
const shopRoutes = require('../routes/shopRoutes'); // ✅ 1. Import
const discountSectionRoutes = require('../routes/discountSectionRoutes'); // ✅ 1. Import
const productCardRoutes = require('../routes/productCardRoutes'); // ✅ ADD THIS
const app = express();

app.use(cors());
app.use(express.json());
app.use(compression());

app.use('/api/cart', cartRoutes);
app.use('/api/explore', exploreRoutes); // ✅ ADD THIS LINE
app.use('/api/shops', shopRoutes); // ✅ 2. Mount
app.use('/api/discount-sections', discountSectionRoutes); // ✅ 2. Mount
app.use('/api/products/feed-cards', productCardRoutes); // ✅ ADD THIS
app.get('/', (req, res) => {
    res.json({ status: "SJ10 Cart Service is Running 🛒" });
});

module.exports = app;
// --- ADD THIS CODE TO RUN LOCALLY ---
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🛒 Cart Service running locally on http://localhost:${PORT}`);
  });
}