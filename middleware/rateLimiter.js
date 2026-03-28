// cart-backend/api/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Protects product fetching from being endlessly scraped
exports.apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, 
    message: { message: 'Too many requests from this IP, please try again later.' }
});

// Protects the Follow/Unfollow button against brute-force spam
exports.followLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 15, // Max 15 follow toggles per minute
    message: { message: 'Too many follow actions. Please slow down.' }
});