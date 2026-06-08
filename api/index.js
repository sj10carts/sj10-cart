// sj cart git/api/index.js
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('../config/database'); 

// Routes Import
const cartRoutes = require('../routes/cartRoutes');
const exploreRoutes = require('../routes/exploreRoutes'); 
const shopRoutes = require('../routes/shopRoutes'); 
const discountSectionRoutes = require('../routes/discountSectionRoutes'); 
const productCardRoutes = require('../routes/productCardRoutes'); 
const markazRoutes = require('../routes/markazRoutes'); 

const app = express();

// =========================================================================
// 🛡️ 1. SECURITY HEADERS (HELMET)
// =========================================================================
// Helmet hides backend tech stack (Express) and prevents XSS & Clickjacking attacks
app.use(helmet({
    crossOriginResourcePolicy: false, // Allows images/resources to load smoothly
}));

// =========================================================================
// 🤖 2. SMART BOT BLOCKER (Allows Google, Blocks Scrapers)
// =========================================================================
const botBlocker = (req, res, next) => {
    const userAgent = req.headers['user-agent'] || '';
    
    // SEO Friendly Bots (Allow them)
    const goodBots = /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot/i;
    // Malicious Scrapers & Scripts (Block them)
    const badBots = /curl|wget|python|scrapy|httpx|postman|insomnia|libwww-perl|go-http-client|java/i;

    if (badBots.test(userAgent) && !goodBots.test(userAgent)) {
        console.warn(`🚫 Blocked Malicious Bot: ${userAgent}`);
        return res.status(403).json({ error: "Access denied. Automated scraping is prohibited." });
    }
    next();
};
app.use(botBlocker);

// =========================================================================
// 🚥 3. RATE LIMITING (Prevents DDoS & Quota Draining)
// =========================================================================
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes window
    max: 500, // Limit each IP to 500 requests per 15 minutes
    message: { error: "Too many requests from this IP, please try again after 15 minutes." },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
// Apply limiter to all /api/ routes
app.use('/api/', apiLimiter);

// =========================================================================
// 🚀 4. MANUAL CORS HEADERS MIDDLEWARE
// =========================================================================
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://www.sj10.pk',
        'https://sj10.pk',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:4005',
        'http://127.0.0.1:5501', 
        'http://localhost:5501',
        'https://sj10.netlify.app'
    ];

    const origin = req.headers.origin;

    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
        // Allows direct API calls (e.g., from Mobile Apps) if origin is missing
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-internal-api-key');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(compression());

// =========================================================================
// 🚀 5. ROUTES MOUNTING
// =========================================================================
app.use('/api/markaz', markazRoutes); 
app.use('/api/cart', cartRoutes);
app.use('/api/explore', exploreRoutes); 
app.use('/api/shops', shopRoutes); 
app.use('/api/discount-sections', discountSectionRoutes); 
app.use('/api/products/feed-cards', productCardRoutes); 

app.get('/', (req, res) => {
    res.json({ status: "SJ10 Cart Service is Secured & Running 🛒🛡️" });
});

module.exports = app;

// --- RUN LOCALLY ---
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 4005;
  const startLocal = async () => {
      try {
          await db.testAllConnections();
          app.listen(PORT, () => {
              console.log(`🛒 Cart Service running locally on http://localhost:${PORT}`);
          });
      } catch (err) {
          console.error("🔴 Local Startup Error:", err);
      }
  };
  startLocal();
}