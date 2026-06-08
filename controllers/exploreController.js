// api/controllers/exploreController.js

const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

exports.getExploreProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50; 
        const { sort = 'smart_ranking', hasVideo, showVerified, search, shard } = req.query;

        const targetClients = shard && shard !== 'all' && clients[shard] ? { [shard]: clients[shard] } : clients;

        // 🚀 OPTIMIZATION 1: Sirf utna data mangwayen jitna page ke liye zaroori hai
        // Agar user Page 1 par hai, toh 50*1 = 50 limit jayegi per shard.
        const fetchLimit = page * limit;

        let baseSql = `SELECT id, title, slug, sku, price, discounted_price, image_url, image_urls, video_url, views, supplier_id, created_at FROM products WHERE status = 'in_stock'`;
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

        // Apply dynamic limit
        baseSql += ` ORDER BY created_at DESC LIMIT ${fetchLimit}`;

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

        // Basic Sorting by Views/Newest before slicing
        allProducts.sort((a, b) => {
            if (sort === 'newest') {
                return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            } else {
                return (b.views || 0) - (a.views || 0);
            }
        });

        // 🚀 OPTIMIZATION 2: Pehle 50 products slice karein, Phir DB se reviews mangwayen! (Saves 95% RAM)
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);

        let supplierMap = new Map();
        let ratingMap = new Map();
        let promotedSet = new Set();

        if (paginatedProducts.length > 0) {
            const productIds = paginatedProducts.map(p => p.id);
            const supplierIds = [...new Set(paginatedProducts.map(p => p.supplier_id).filter(Boolean))];

            // Ab MySQL ko 1800 ke bajaye sirf in 50 products ko dhoondna parrega
            const [ratingsRes, suppliersRes, promotedRes] = await Promise.all([
                db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds.length ? productIds : [0]]).catch(() => [[]]),
                db.suppliers.query(`SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)`, [supplierIds.length ? supplierIds : [0]]).catch(() => [[]]),
                db.inventory.query(`SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW() AND product_id IN (?)`, [productIds.length ? productIds : [0]]).catch(() => [[]])
            ]);

            if (ratingsRes[0]) ratingsRes[0].forEach(r => ratingMap.set(String(r.product_id), r));
            if (suppliersRes[0]) suppliersRes[0].forEach(s => supplierMap.set(String(s.id), s));
            if (promotedRes[0]) promotedRes[0].forEach(p => promotedSet.add(String(p.product_id)));
        }

        let optimizedProducts = paginatedProducts.map(p => {
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

            const isPromoted = promotedSet.has(String(p.id));

            return {
                id: p.id, t: p.title, s: p.slug, sku: p.sku,
                p: parseFloat(p.price || 0), dp: parseFloat(p.discounted_price || p.price),
                img: finalImg, v: String(sInfo.verified_status).toLowerCase() === 'verified',
                b: sInfo.brand_name || 'SJ10', r: parseFloat(rInfo.avg_rating || 0), rc: parseInt(rInfo.review_count || 0), hv: hasVideo,
                promo: isPromoted
            };
        });

        // Apply filters on the final 50 array
        if (showVerified === 'true') {
            optimizedProducts = optimizedProducts.filter(p => p.v === true);
        }

        // Smart Sort: Promoted items at the top
        if (sort === 'smart_ranking') {
            optimizedProducts.sort((a, b) => (b.promo === true ? 1 : 0) - (a.promo === true ? 1 : 0));
        }

        // 🚀 OPTIMIZATION 3: THE ULTIMATE 1-MONTH CLOUDFLARE CACHE HEADER
        // s-maxage=2592000 (Cloudflare par 30 din tak save rakhega)
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400');
        
        res.status(200).json({ 
            products: optimizedProducts, 
            totalCount: page === 1 ? totalCount : undefined 
        });

    } catch (error) {
        console.error("Explore API Error:", error);
        res.status(500).json({ products: [], error: "Server Error" });
    }
};