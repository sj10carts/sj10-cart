const { createClient } = require('redis');

// Server 3 ka IP aur Password hum .env se uthayenge
const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.log('❌ Redis Error:', err));

(async () => {
    try {
        await redisClient.connect();
        console.log("⚡ Connected to Centralized Redis on Server 3");
    } catch (e) {
        console.log("⚠️ Redis not connected. Running without cache.");
    }
})();

module.exports = redisClient;