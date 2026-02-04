// ACTION: Replace this file's content in 'cart-backend/api/config/database.js'

require('dotenv').config();
const mysql = require('mysql2/promise');
const { URL } = require('url');

const createPool = (connectionUrl) => {
    if (!connectionUrl) {
        console.warn(`⚠️ DB connection URL is missing. This pool will not be created.`);
        return null;
    }
    try {
        const url = new URL(connectionUrl);
        return mysql.createPool({
            host: url.hostname, user: url.username, password: url.password,
            database: url.pathname.substring(1), port: url.port || 3306,
            ssl: { rejectUnauthorized: true },
            waitForConnections: true, connectionLimit: 2, // Increased slightly for more operations
            queueLimit: 0, 
            connectTimeout: 20000, enableKeepAlive: true
        });
    } catch (error) { 
        console.error(`🔴 DB Config Error for ${connectionUrl}:`, error);
        return null;
    }
};

// ✅ ADDED the required database pools for the explore logic
const pools = {
    carts: createPool(process.env.DB_CARTS_URL),
    inventory: createPool(process.env.DB_INVENTORY_URL),
    suppliers: createPool(process.env.DB_SUPPLIERS_URL),
    reviews: createPool(process.env.DB_REVIEWS_URL),
    social: createPool(process.env.DB_SOCIAL_URL) // ✅ ADDED THIS LINE
};

module.exports = pools;