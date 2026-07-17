// config/database.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const { Pool } = require('pg'); // 🚨 PostgreSQL Driver
const { URL } = require('url');

const createPool = (connectionUrl) => {
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
            port: url.port || 4000,
            ssl: { rejectUnauthorized: true },
            waitForConnections: true, 
            connectionLimit: 5, 
            queueLimit: 0, 
            connectTimeout: 20000, 
            enableKeepAlive: true
        });
    } catch (error) { 
        console.error(`🔴 DB Config Error:`, error.message);
        return null;
    }
};

const pools = {
    // 🟢 ORACLE POSTGRES POOL (New Database)
    oracle: new Pool({
        connectionString: process.env.DB_ORACLE_PRODUCTS_URL,
        ssl: { rejectUnauthorized: false } // Vercel Serverless safe setting
    }),

    // 🟡 TiDB MYSQL POOLS
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
        
        // Test Oracle
        if (pools.oracle) {
            try {
                const client = await pools.oracle.connect();
                console.log("✅ Carts connected to [Oracle Postgres] Products.");
                client.release();
            } catch (e) {
                console.error("🔴 Failed to connect to Oracle Postgres:", e.message);
            }
        }

        // Test TiDB
        if (pools.carts) {
            try {
                const conn = await pools.carts.getConnection();
                console.log("✅ Carts connected to [MySQL Carts] DB.");
                conn.release();
            } catch (e) {
                console.error("🔴 Failed to connect to MySQL Carts:", e.message);
            }
        }
    }
};

module.exports = pools;