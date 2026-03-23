// api/controllers/exploreController.js

const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

exports.getExploreProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50; // ✅ LIMIT INCREASED TO 50
        const { sort = 'smart_ranking', hasVideo, showVerified, search, shard } = req.query;

        // --- 1. INTELLIGENT SHARD SELECTION ---
        const targetClients = shard && shard !== 'all' && clients[shard] ? { [shard]: clients[shard] } : clients;

        // --- 2. BUILD TURSO QUERY (Optimized Columns Only) ---
        // Fetch only what the Lite Card needs to save RAM and Bandwidth
        let baseSql = `SELECT id, title, slug, sku, price, discounted_price, image_urls, video_url, views, supplier_id, created_at FROM products WHERE status = 'in_stock'`;
        let countSql = `SELECT COUNT(*) as total FROM products WHERE status = 'in_stock'`;
        let queryArgs = [];

        if (search) { 
            const term = `%${search.trim().toLowerCase()}%`;
            baseSql += ` AND LOWER(title) LIKE ?`; 
            countSql += ` AND LOWER(title) LIKE ?`;
            queryArgs.push(term); 
        }

        if (hasVideo === 'true') {
            baseSql += ` AND (video_url IS NOT NULL AND video_url != '' OR image_urls LIKE '%.mp4%')`;
            countSql += ` AND (video_url IS NOT NULL AND video_url != '' OR image_urls LIKE '%.mp4%')`;
        }

        // --- 3. FETCH DATA FROM TURSO ---
        let totalCount = 0;
        if (page === 1) {
            const countPromises = Object.values(targetClients).filter(c => c).map(c => 
                c.execute({ sql: countSql, args: queryArgs })
                .then(r => r.rows[0]?.total || 0).catch(() => 0)
            );
            const counts = await Promise.all(countPromises);
            totalCount = counts.reduce((a, b) => a + b, 0);
        }

        const productPromises = Object.values(targetClients).filter(c => c).map(c =>
            c.execute({ sql: baseSql, args: queryArgs })
             .then(r => r.rows).catch(() => [])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // --- 4. ENRICHMENT (MySQL Data) ---
        let supplierMap = new Map();
        let ratingMap = new Map();
        let promotedSet = new Set();

        if (allProducts.length > 0) {
            const productIds = allProducts.map(p => p.id);
            const supplierIds = [...new Set(allProducts.map(p => p.supplier_id).filter(Boolean))];

            const [ratingsRes, suppliersRes, promotedRes] = await Promise.all([
                db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds.length ? productIds : [0]]).catch(() => [[]]),
                db.suppliers.query(`SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)`, [supplierIds.length ? supplierIds : [0]]).catch(() => [[]]),
                db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW()").catch(() => [[]])
            ]);

            if (ratingsRes[0]) ratingsRes[0].forEach(r => ratingMap.set(String(r.product_id), r));
            if (suppliersRes[0]) suppliersRes[0].forEach(s => supplierMap.set(String(s.id), s));
            if (promotedRes[0]) promotedRes[0].forEach(p => promotedSet.add(String(p.product_id)));
        }

        // Apply Verified Filter BEFORE sorting & slicing
        if (showVerified === 'true') {
            allProducts = allProducts.filter(p => {
                const sInfo = supplierMap.get(String(p.supplier_id));
                return sInfo && String(sInfo.verified_status).toLowerCase() === 'verified';
            });
        }

        // --- 5. SMART SORTING ---
        allProducts.sort((a, b) => {
            if (sort === 'newest') {
                return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            } else {
                const aPromo = promotedSet.has(String(a.id)) ? 1 : 0;
                const bPromo = promotedSet.has(String(b.id)) ? 1 : 0;
                if (aPromo !== bPromo) return bPromo - aPromo;
                
                const aRev = parseInt((ratingMap.get(String(a.id)) || {}).review_count || 0);
                const bRev = parseInt((ratingMap.get(String(b.id)) || {}).review_count || 0);
                if (aRev !== bRev) return bRev - aRev;
                
                return (b.views || 0) - (a.views || 0);
            }
        });

        // --- 6. PAGINATION & LITE CARD MAPPING ---
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);
        
        // ✅ MAP EXACTLY TO ProductCardLite FORMAT
        const optimizedProducts = paginatedProducts.map(p => {
            const sInfo = supplierMap.get(String(p.supplier_id)) || { verified_status: 'unverified', brand_name: 'Unknown' };
            const rInfo = ratingMap.get(String(p.id)) || { avg_rating: 0, review_count: 0 };
            
            let finalImg = p.image_url || '/placeholder.jpg';
            let hasVideo = false;

            try {
                const parsedImgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : p.image_urls;
                if (Array.isArray(parsedImgs) && parsedImgs.length > 0) finalImg = parsedImgs[0];
                if (typeof p.image_urls === 'string' && p.image_urls.includes('.mp4')) hasVideo = true;
            } catch(e) {}
            if (p.video_url && p.video_url.length > 5) hasVideo = true;

            return {
                id: p.id,
                t: p.title,
                s: p.slug,
                sku: p.sku,
                p: parseFloat(p.price || 0),
                dp: parseFloat(p.discounted_price || p.price),
                img: finalImg,
                v: String(sInfo.verified_status).toLowerCase() === 'verified',
                b: sInfo.brand_name || 'SJ10',
                r: parseFloat(rInfo.avg_rating || 0),
                rc: parseInt(rInfo.review_count || 0),
                hv: hasVideo
            };
        });

        // --- 7. CACHING STRATEGY ---
        // Cache at browser for 1 minute, CDN for 5 minutes
        res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        
        res.status(200).json({ 
            products: optimizedProducts, 
            totalCount: page === 1 ? totalCount : undefined 
        });

    } catch (error) {
        console.error("Explore API Error:", error);
        res.status(500).json({ products: [], error: "Server Error" });
    }
};