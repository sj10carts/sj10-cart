const db = require('../config/database');
const redis = require('../config/redis'); // 🚨 IMPORT REDIS

/**
 * 🔥 LIGHTWEIGHT PRODUCT CARDS API (100% ORACLE DB + REDIS CACHED)
 * Optimized for: Zero Quota Usage, Lightning Fast CDN Caching (1 Month)
 */
exports.getProductCards = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40; 
    const offset = (page - 1) * limit;
    
    // Custom Redis Cache Key per page
    const cacheKey = `product_cards_v6_p${page}_l${limit}`;
    const CACHE_HEADER = 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400';

    try {
        // 1. ⚡ CHECK REDIS CACHE (Super Cache Check)
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`⚡ [REDIS] Serving Lite Product Cards (Page ${page}) from Cache`);
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json(JSON.parse(cached));
        }

        console.log(`🟢 [ORACLE DB] Cache Miss! Fetching Lite Product Cards -> Page: ${page}`);

        // 2. 🚨 FETCH DIRECTLY FROM ORACLE
        const sql = `
            SELECT id, title, slug, sku, price, discounted_price, image_url, image_urls, video_url, supplier_id 
            FROM products 
            WHERE status = 'in_stock'
            ORDER BY created_at DESC 
            LIMIT $1 OFFSET $2
        `;
        const args = [limit, offset];

        const result = await db.oracle.query(sql, args);
        const rawProducts = result.rows;

        // 🚀 Empty page cache protection
        if (rawProducts.length === 0) {
            const emptyResponse = { products: [], page, hasMore: false };
            // Cache empty state too for 10 minutes to prevent database spam
            await redis.setEx(cacheKey, 600, JSON.stringify(emptyResponse));
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json(emptyResponse);
        }

        const productIds = rawProducts.map(p => p.id);
        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id).filter(Boolean))];
        
        let supplierMap = new Map();
        let ratingsMap = new Map();

        // 3. ⚡ PARALLEL TiDB MYSQL ENRICHMENT
        const enrichmentPromises = [];

        if (supplierIds.length > 0) {
            enrichmentPromises.push(
                db.suppliers.query("SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)", [supplierIds])
                .then(([rows]) => rows.forEach(s => {
                    supplierMap.set(String(s.id), {
                        isVerified: String(s.verified_status).toLowerCase() === 'verified',
                        brand: s.brand_name
                    });
                })).catch(e => console.warn("⚠️ Suppliers fetch failed in ProductCards:", e.message))
            );
        }

        if (productIds.length > 0 && db.reviews) {
            enrichmentPromises.push(
                db.reviews.query("SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)", [productIds])
                .then(([rows]) => rows.forEach(r => {
                    ratingsMap.set(String(r.product_id), { 
                        rating: parseFloat(r.avg_rating), 
                        count: parseInt(r.review_count) 
                    });
                })).catch(e => console.warn("⚠️ Ratings fetch failed in ProductCards:", e.message))
            );
        }

        await Promise.all(enrichmentPromises);

        // 4. TRANSFORM TO COMPACT OBJECTS
        const optimizedProducts = rawProducts.map(p => {
            const sInfo = supplierMap.get(String(p.supplier_id)) || { isVerified: false, brand: 'SJ10 Official' };
            const rInfo = ratingsMap.get(String(p.id)) || { rating: 0, count: 0 };
            
            let finalImg = p.image_url;
            try {
                const parsedImgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : p.image_urls;
                if (Array.isArray(parsedImgs) && parsedImgs.length > 0) finalImg = parsedImgs[0];
            } catch(e) {}
            
            const hasVideo = (p.video_url && p.video_url.length > 5) || (typeof p.image_urls === 'string' && p.image_urls.includes('.mp4'));

            return { 
                id: p.id, 
                t: p.title, 
                s: p.slug, 
                sku: p.sku || 'N/A', 
                p: parseFloat(p.price || 0), 
                dp: parseFloat(p.discounted_price || p.price || 0), 
                img: finalImg, 
                v: sInfo.isVerified, 
                b: sInfo.brand, 
                r: rInfo.rating, 
                rc: rInfo.count, 
                hv: hasVideo 
            };
        });

        const responseData = { 
            products: optimizedProducts, 
            page, 
            hasMore: rawProducts.length === limit 
        };

        // 5. 💾 SAVE TO REDIS (Cache for 10 Minutes - 600 seconds)
        await redis.setEx(cacheKey, 600, JSON.stringify(responseData));

        // 6. 🔥 THE ULTIMATE 1-MONTH CACHE HEADER 🔥
        res.setHeader('Cache-Control', CACHE_HEADER);
        res.json(responseData);

    } catch (error) {
        console.error("🔴 Product Cards API Error:", error.message);
        res.status(500).json({ message: "Error fetching cards" });
    }
};