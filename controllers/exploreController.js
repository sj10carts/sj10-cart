// api/controllers/exploreController.js

const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

const parseProduct = (p) => {
    if (!p) return null;
    try {
        if (typeof p.image_urls === 'string') {
            try { p.image_urls = JSON.parse(p.image_urls); } catch (e) { p.image_urls = [p.image_url]; }
        } else if (!Array.isArray(p.image_urls)) { p.image_urls = []; }
    } catch (e) { p.image_urls = []; }
    p.price = parseFloat(p.price || 0);
    p.discounted_price = parseFloat(p.discounted_price || p.price);
    p.views = p.views || 0;
    p.quantity = p.quantity ? parseInt(p.quantity) : 0;
    p.video_url = (p.video_url && p.video_url.length > 5) ? p.video_url : null;
    return p;
};

exports.getExploreProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        
        const { sort = 'default', hasVideo, showVerified, search, shard } = req.query;

        // --- INTELLIGENT SHARD SELECTION ---
        // If a specific shard is requested (e.g., 'shard_women_fashion'), only use that one.
        // Otherwise, query all clients. This is key for performance.
        const targetClients = shard && clients[shard] ? { [shard]: clients[shard] } : clients;

        // --- BUILD QUERY ---
        let baseSql = `SELECT id, title, slug, price, discounted_price, image_urls, video_url, views, supplier_id, created_at, quantity FROM products WHERE 1=1`;
        let countSql = `SELECT COUNT(*) as total FROM products WHERE 1=1`;
        let queryArgs = [];

        if (search) { 
            const term = `%${search.trim().toLowerCase()}%`;
            baseSql += ` AND LOWER(title) LIKE ?`; 
            countSql += ` AND LOWER(title) LIKE ?`;
            queryArgs.push(term); 
        }

        if (hasVideo === 'true') {
            baseSql += ` AND video_url IS NOT NULL AND video_url != ''`;
            countSql += ` AND video_url IS NOT NULL AND video_url != ''`;
        }

        // --- EXECUTE QUERIES ---
        
        // Total Count (On Page 1)
        let totalCount = 0;
        if (page === 1) {
            const countPromises = Object.values(targetClients).filter(c => c).map(c => 
                c.execute({ sql: countSql, args: queryArgs })
                .then(r => r.rows[0]?.total || 0).catch(() => 0)
            );
            const counts = await Promise.all(countPromises);
            totalCount = counts.reduce((a, b) => a + b, 0);
        }

        // Fetch Products
        const BUFFER_SIZE = limit * 4; 
        const productPromises = Object.values(targetClients).filter(c => c).map(c =>
            c.execute({ sql: `${baseSql} LIMIT ?`, args: [...queryArgs, BUFFER_SIZE] })
             .then(r => r.rows).catch(() => [])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // --- ENRICHMENT (MySQL Data) ---
        if (allProducts.length > 0) {
            const productIds = allProducts.map(p => p.id);
            const supplierIds = [...new Set(allProducts.map(p => p.supplier_id).filter(Boolean))];

            const [ratingsRes, suppliersRes, promotedRes] = await Promise.all([
                db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds]).catch(() => [[]]),
                db.suppliers.query(`SELECT id, verified_status FROM suppliers WHERE id IN (?)`, [supplierIds]).catch(() => [[]]),
                db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW()").catch(() => [[]]),
            ]);

            const ratingMap = new Map(ratingsRes[0].map(r => [r.product_id, r]));
            const supplierMap = new Map(suppliersRes[0].map(s => [s.id, s.verified_status === 'verified']));
            const promotedSet = new Set(promotedRes[0].map(p => p.product_id));

            allProducts = allProducts.map(p => {
                const parsed = parseProduct(p);
                const rData = ratingMap.get(p.id) || { avg_rating: 0, review_count: 0 };
                return {
                    ...parsed,
                    isPromoted: promotedSet.has(p.id),
                    review_count: rData.review_count,
                    avg_rating: parseFloat(rData.avg_rating),
                    supplier_verified: supplierMap.get(p.supplier_id) || false,
                    has_video: !!parsed.video_url 
                };
            });
        }

        // --- FINAL SORTING & FILTERING ---
        if (showVerified === 'true') allProducts = allProducts.filter(p => p.supplier_verified);

        allProducts.sort((a, b) => {
            if (a.isPromoted !== b.isPromoted) return b.isPromoted ? 1 : -1;
            if (sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
            // ... add other sorts as needed
            return b.views - a.views;
        });

        // --- PAGINATION & RESPONSE ---
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);
        
        res.status(200).json({ 
            products: paginatedProducts, 
            totalCount: page === 1 ? totalCount : undefined 
        });

    } catch (error) {
        console.error("Explore API Error:", error);
        res.status(500).json({ products: [], error: "Server Error" });
    }
};