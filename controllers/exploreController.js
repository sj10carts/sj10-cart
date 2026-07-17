const db = require('../config/database');
const redis = require('../config/redis');

// --- Helper: Parse Images safely ---
const parseProduct = (p) => {
    let images = [];
    try {
        if (Array.isArray(p.image_urls)) {
            images = p.image_urls;
        } else if (typeof p.image_urls === 'string' && p.image_urls.startsWith('[')) {
            images = JSON.parse(p.image_urls);
        } else {
            images = [p.image_url || p.image_urls].filter(Boolean);
        }
    } catch (e) {
        images = [p.image_url].filter(Boolean);
    }
    return images.length > 0 ? images : ["/placeholder.jpg"];
};

// ======================================================
// 🔥 ENTERPRISE DISCOVERY: GET EXPLORE PRODUCTS (100% ORACLE READY)
// Optimizations: Infinite Scroll (40 Batch), Postgres ILIKE, Redis Cache
// ======================================================
exports.getExploreProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 40; // Strict 40 per batch as requested
        const { sort = 'smart_ranking', hasVideo, showVerified, search } = req.query;
        const offset = (page - 1) * limit;

        // 1. ⚡ CHECK REDIS CACHE (Instant Speed)
        const cacheKey = `explore_feed_v7_${page}_${limit}_${sort}_${encodeURIComponent(search || '')}_${hasVideo || ''}_${showVerified || ''}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`⚡ [REDIS] Serving Explore Feed (Page ${page}) from Cache`);
            return res.json(JSON.parse(cached));
        }

        console.log(`🟢 [ORACLE DB] Fetching Explore Feed -> Page: ${page}, Limit: ${limit}`);

        // 2. BUILD ORACLE POSTGRES SQL (Bina Turso Shards ke)
        let sql = `SELECT * FROM products WHERE status = 'in_stock'`;
        let countSql = `SELECT COUNT(*) as total FROM products WHERE status = 'in_stock'`;
        let params = [];
        let pIndex = 1;

        // Search Filter (Postgres Case-Insensitive ILIKE)
        if (search) {
            const searchPattern = `%${search.trim().toLowerCase()}%`;
            sql += ` AND (title ILIKE $${pIndex} OR sku ILIKE $${pIndex} OR description ILIKE $${pIndex})`;
            countSql += ` AND (title ILIKE $${pIndex} OR sku ILIKE $${pIndex} OR description ILIKE $${pIndex})`;
            params.push(searchPattern);
            pIndex++;
        }

        // Video Filter
        if (hasVideo === 'true') {
            sql += ` AND (video_url IS NOT NULL AND video_url != '' OR image_urls LIKE '%.mp4%')`;
            countSql += ` AND (video_url IS NOT NULL AND video_url != '' OR image_urls LIKE '%.mp4%')`;
        }

        // Base Sorting in Database
        if (sort === 'newest') {
            sql += ` ORDER BY created_at DESC`;
        } else {
            // Default: Most viewed (Viral) first
            sql += ` ORDER BY views DESC`;
        }

        // Pagination limit & offset
        sql += ` LIMIT $${pIndex} OFFSET $${pIndex + 1}`;
        const finalArgs = [...params, limit, offset];

        // Run Parallel Queries in Oracle Postgres (Oracle)
        const [dataRes, countRes] = await Promise.all([
            db.oracle.query(sql, finalArgs),
            page === 1 ? db.oracle.query(countSql, params) : Promise.resolve({ rows: [{ total: 0 }] })
        ]);

        const rawProducts = dataRes.rows;
        const totalDatabaseCount = parseInt(countRes.rows[0].total || 0);

        if (rawProducts.length === 0) {
            return res.json({ products: [], totalCount: totalDatabaseCount, hasMore: false });
        }

        // 3. ENRICH WITH TiDB MYSQL METRICS (Suppliers, Ratings, Favorites, Ads)
        const pIds = rawProducts.map(p => p.id);
        const sIds = [...new Set(rawProducts.map(p => p.supplier_id).filter(Boolean))];

        const [suppliersRes, ratingsRes, favoritesRes, promotedRes] = await Promise.all([
            db.suppliers.query("SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)", [sIds.length ? sIds : [0]]),
            db.reviews.query("SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)", [pIds.length ? pIds : [0]]),
            db.db_social ? db.db_social.query("SELECT product_id, COUNT(*) as f_count FROM product_favorites WHERE product_id IN (?) GROUP BY product_id", [pIds.length ? pIds : [0]]) : Promise.resolve([[]]),
            db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status = 'paid' AND start_date <= NOW() AND end_date >= NOW() AND product_id IN (?)", [pIds.length ? pIds : [0]])
        ]);

        const supplierMap = new Map((suppliersRes[0] || []).map(s => [String(s.id), s]));
        const ratingMap = new Map((ratingsRes[0] || []).map(r => [String(r.product_id), r]));
        const favoriteMap = new Map((favoritesRes[0] || []).map(f => [String(f.product_id), f.f_count]));
        const promotedSet = new Set((promotedRes[0] || []).map(p => String(p.product_id)));

        // 4. MAP TO FRONTEND LITE SHORTHAND FORMAT (CORS & Next.js Optimized)
        let enrichedProducts = rawProducts.map(p => {
            const sInfo = supplierMap.get(String(p.supplier_id)) || { verified_status: 'unverified', brand_name: 'SJ10 Official' };
            const rInfo = ratingMap.get(String(p.id)) || { avg_rating: 0, review_count: 0 };
            const favCount = favoriteMap.get(String(p.id)) || 0;
            const isPromoted = promotedSet.has(String(p.id));

            const images = parseProduct(p);

            return {
                id: p.id,
                t: p.title,
                s: p.slug,
                sku: p.sku || 'N/A',
                p: parseFloat(p.price || 0),
                dp: parseFloat(p.discounted_price || p.price || 0),
                img: images[0],
                v: String(sInfo.verified_status).toLowerCase() === 'verified',
                b: sInfo.brand_name || 'SJ10',
                r: parseFloat(rInfo.avg_rating || 0),
                rc: parseInt(rInfo.review_count || 0),
                favorites: parseInt(favCount),
                views: parseInt(p.views || 0),
                hv: (p.video_url && p.video_url.length > 5) || images.some(u => typeof u === 'string' && u.includes('.mp4')),
                promo: isPromoted
            };
        });

        // Apply verified seller filter
        if (showVerified === 'true') {
            enrichedProducts = enrichedProducts.filter(p => p.v === true);
        }

        // --- 5. 🔥 SMART EXPLORE SORTING ALGORITHM (The Recommender Brain) ---
        // Priority Order: Most Viral (Views) > Promoted Ads > Most Favorited > Most Reviewed > Created At (Latest)
        if (sort === 'smart_ranking') {
            enrichedProducts.sort((a, b) => {
                // Priority 1: Views (Viral)
                if (b.views !== a.views) return b.views - a.views;
                
                // Priority 2: Promoted Ads
                if (b.promo !== a.promo) return (b.promo ? 1 : 0) - (a.promo ? 1 : 0);
                
                // Priority 3: Favorites
                if (b.favorites !== a.favorites) return b.favorites - a.favorites;
                
                // Priority 4: Reviews
                if (b.rc !== a.rc) return b.rc - a.rc;
                
                // Priority 5: Fallback to ID/Latest sort
                return String(b.id).localeCompare(String(a.id));
            });
        }

        // hasMore tells Next.js if there are more products to fetch on scroll [2]
        const hasMore = (offset + limit) < totalDatabaseCount;
        const responseData = {
            products: enrichedProducts,
            totalCount: totalDatabaseCount,
            hasMore
        };

        // Cache in Redis for 5 Minutes
        await redis.setEx(cacheKey, 300, JSON.stringify(responseData));

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.status(200).json(responseData);

    } catch (error) {
        console.error("🔴 Explore API Error:", error.message);
        res.status(500).json({ products: [], error: "Internal Server Error" });
    }
};