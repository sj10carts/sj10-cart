// sj cart git/config/database.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const { URL } = require('url');

const createPool = (connectionUrl) => {
    // 🟢 FIXED: Crash-free validation for Vercel Serverless environment
    if (!connectionUrl || connectionUrl.trim() === '' || connectionUrl.includes('undefined')) {
        console.warn(`⚠️ DB connection URL is missing or malformed. Skipping pool creation.`);
        return null;
    }
    try {
        const url = new URL(connectionUrl);
        return mysql.createPool({
            host: url.hostname, 
            user: url.username, 
            password: url.password,
            database: url.pathname.substring(1), 
            port: url.port || 3306,
            ssl: { rejectUnauthorized: true },
            waitForConnections: true, 
            connectionLimit: 5, 
            queueLimit: 0, 
            connectTimeout: 20000, 
            enableKeepAlive: true
        });
    } catch (error) { 
        console.error(`🔴 DB Config Error for ${connectionUrl}:`, error.message);
        return null;
    }
};

const pools = {
    carts: createPool(process.env.DB_CARTS_URL),
    inventory: createPool(process.env.DB_INVENTORY_URL),
    suppliers: createPool(process.env.DB_SUPPLIERS_URL),
    reviews: createPool(process.env.DB_REVIEWS_URL),
    social: createPool(process.env.DB_SOCIAL_URL),
    sku_master: createPool(process.env.DB_SKU_URL),       
    products_backup: createPool(process.env.DB_BACKUP_URL),
    products: createPool(process.env.DB_INVENTORY_URL),

    testAllConnections: async () => {
        console.log("Testing Carts Database Connections...");
        const keys = Object.keys(pools);
        for (const key of keys) {
            if (key === 'testAllConnections') continue;
            if (pools[key]) {
                try {
                    const conn = await pools[key].getConnection();
                    await conn.ping();
                    conn.release();
                    console.log(`✅ Carts connected to [${key}] DB.`);
                } catch (e) { 
                    console.error(`🔴 Failed to connect to [${key}]:`, e.message); 
                }
            }
        }
    }
};

module.exports = pools;