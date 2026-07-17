const db = require('../config/database');
const redis = require('../config/redis'); // 🚨 IMPORT REDIS

// ======================================================
// 🚫 1. GET FOLLOWED SHOPS (🚫 DO NOT CACHE - Personal User Data)
// ======================================================
exports.getFollowedShops = async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch followed IDs from TiDB MySQL (Social DB)
        const [follows] = await db.social.query(
            "SELECT supplier_id FROM supplier_followers WHERE user_id = ?", 
            [userId]
        );
        if (follows.length === 0) {
            res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
            return res.status(200).json([]);
        }
        
        const supplierIds = follows.map(f => f.supplier_id);

        // Fetch supplier profiles from TiDB MySQL (Suppliers DB)
        const [shops] = await db.suppliers.query(
            `SELECT id, brand_name, profile_pic, verified_status FROM suppliers WHERE id IN (?)`,
            [supplierIds]
        );
        
        // Ensure no cache for private/authenticated routes
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json(shops.map(s => ({
            ...s,
            name: s.brand_name || 'SJ10 Seller'
        })));
    } catch (error) {
        console.error("🔴 Followed Shops Error:", error.message);
        res.status(500).json({ message: "Failed to fetch followed shops" });
    }
};

// ======================================================
// 🔥 2. GET SUPPLIER PRODUCTS (ORACLE POSTGRES + REDIS CACHED ⚡)
// Cache Timing: 10 Minutes (600s)
// ======================================================
exports.getSupplierProducts = async (req, res) => {
    const { id } = req.params; // Supplier/Shop ID
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40; 
    const offset = (page - 1) * limit;
    const { sort = 'newest', search = '' } = req.query;

    // Custom cache key for different pages and search queries
    const cacheKey = `supplier_products_v5_${id}_p${page}_l${limit}_s${sort}_q${encodeURIComponent(search)}`;
    const CACHE_HEADER = 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400';

    try {
        // A. ⚡ Check Redis Cache (Bypasses database completely if hit)
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`⚡ [REDIS] Serving Supplier ${id.substring(0,8)}... Products from Cache`);
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json(JSON.parse(cached));
        }

        console.log(`🟢 [ORACLE DB] Cache Miss! Fetching Products for Supplier: ${id}`);

        // B. Build Postgres Query (Fast single table access, no shards!)
        let sql = `
            SELECT id, title, slug, sku, price, discounted_price, image_url, image_urls, video_url, created_at 
            FROM products 
            WHERE status = 'in_stock' AND supplier_id = $1
        `;
        let countSql = `SELECT COUNT(*) as total FROM products WHERE status = 'in_stock' AND supplier_id = $1`;
        let params = [id];
        let pIndex = 2; // Postgres placeholder counter ($1, $2...)

        // Search within supplier store (Postgres ILIKE)
        if (search) {
            const searchPattern = `%${search.trim().toLowerCase()}%`;
            sql += ` AND (title ILIKE $${pIndex} OR sku ILIKE $${pIndex})`;
            countSql += ` AND (title ILIKE $${pIndex} OR sku ILIKE $${pIndex})`;
            params.push(searchPattern);
            pIndex++;
        }

        // Sorting directly in Postgres Database for efficiency
        if (sort === 'price_low') {
            sql += ` ORDER BY COALESCE(discounted_price, price) ASC`;
        } else if (sort === 'price_high') {
            sql += ` ORDER BY COALESCE(discounted_price, price) DESC`;
        } else {
            sql += ` ORDER BY created_at DESC`;
        }

        // Pagination
        sql += ` LIMIT $${pIndex} OFFSET $${pIndex + 1}`;
        const finalArgs = [...params, limit, offset];

        // Execute Postgres queries
        const [dataRes, countRes] = await Promise.all([
            db.oracle.query(sql, finalArgs),
            db.oracle.query(countSql, params)
        ]);

        const rawProducts = dataRes.rows;
        const totalCount = parseInt(countRes.rows[0].total || 0);

        if (rawProducts.length === 0) {
            const emptyResponse = { products: [], totalCount: 0, hasMore: false };
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json(emptyResponse);
        }

        // Map to standard layout expected by frontend cards
        const finalProducts = rawProducts.map(p => {
            let finalImg = p.image_url;
            let imageList = [];
            try {
                const parsedImgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : p.image_urls;
                if (Array.isArray(parsedImgs) && parsedImgs.length > 0) {
                    finalImg = parsedImgs[0];
                    imageList = parsedImgs;
                } else {
                    imageList = [finalImg].filter(Boolean);
                }
            } catch(e) {
                imageList = [finalImg].filter(Boolean);
            }
            
            const hasVideo = (p.video_url && p.video_url.length > 5) || (typeof p.image_urls === 'string' && p.image_urls.includes('.mp4'));

            return {
                ...p,
                price: parseFloat(p.price || 0),
                discounted_price: parseFloat(p.discounted_price || p.price || 0),
                image_urls: imageList,
                image_url: finalImg,
                has_video: hasVideo
            };
        });

        const hasMore = (offset + limit) < totalCount;
        const responseData = { 
            products: finalProducts,
            totalCount,
            hasMore
        };

        // C. 💾 Save to Redis for 10 Minutes (600 seconds)
        await redis.setEx(cacheKey, 600, JSON.stringify(responseData));

        res.setHeader('Cache-Control', CACHE_HEADER);
        res.status(200).json(responseData);

    } catch (error) {
        console.error("🔴 Supplier Products Error:", error.message);
        res.status(500).json({ products: [], error: "Server Error" });
    }
};