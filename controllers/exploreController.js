// api/controllers/exploreController.js

const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

// Helper to clean up data types
const parseProduct = (p) => {
    if (!p) return null;
    try {
        if (typeof p.image_urls === 'string') {
            try { p.image_urls = JSON.parse(p.image_urls); } catch (e) { p.image_urls = [p.image_url]; }
        } else if (!Array.isArray(p.image_urls)) { p.image_urls =[]; }
    } catch (e) { p.image_urls =[]; }
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
        
        // Use 'sort' parameter from frontend
        const { sort = 'smart_ranking', hasVideo, showVerified, search, shard } = req.query;

        // --- 1. INTELLIGENT SHARD SELECTION ---
        const targetClients = shard && clients[shard] ? { [shard]: clients[shard] } : clients;

        // --- 2. BUILD TURSO QUERY (NO LIMITATIONS HERE ANYMORE) ---
        let baseSql = `SELECT id, title, slug, price, discounted_price, image_urls, video_url, views, supplier_id, created_at, quantity FROM products WHERE 1=1`;
        let countSql = `SELECT COUNT(*) as total FROM products WHERE 1=1`;
        let queryArgs =[];

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

        // --- 3. FETCH DATA FROM TURSO ---
        
        // A. Get Total Count (Only on page 1)
        let totalCount = 0;
        if (page === 1) {
            const countPromises = Object.values(targetClients).filter(c => c).map(c => 
                c.execute({ sql: countSql, args: queryArgs })
                .then(r => r.rows[0]?.total || 0).catch(() => 0)
            );
            const counts = await Promise.all(countPromises);
            totalCount = counts.reduce((a, b) => a + b, 0);
        }

        // B. Get Raw Products - NO LIMIT applied here to allow cross-shard sorting!
        // This fixes the 2000 product limit. We get everything, sort it perfectly, then slice.
        const productPromises = Object.values(targetClients).filter(c => c).map(c =>
            c.execute({ sql: baseSql, args: queryArgs })
             .then(r => r.rows).catch(() =>[])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // --- 4. ENRICHMENT (MySQL Data - Verified, Reviews & Promoted) ---
        if (allProducts.length > 0) {
            const productIds = allProducts.map(p => p.id);
            const supplierIds =[...new Set(allProducts.map(p => p.supplier_id).filter(Boolean))];

            const [ratingsRes, suppliersRes, promotedRes, discountNamesRes] = await Promise.all([
                // 1. Ratings (for review_count)
                db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds]).catch(() => [[]]),
                // 2. Suppliers (For Verified Badge)
                db.suppliers.query(`SELECT id, verified_status FROM suppliers WHERE id IN (?)`, [supplierIds]).catch(() => [[]]),
                // 3. Promoted Status
                db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW()").catch(() => [[]]),
                // 4. Discounts
                db.inventory.query(`
                    SELECT dp.product_id, d.name 
                    FROM discount_products dp 
                    JOIN discounts d ON dp.discount_id = d.id 
                    WHERE d.is_active = 1 AND dp.product_id IN (?)
                `, [productIds]).catch(() => [[]])
            ]);

            const ratingMap = new Map(ratingsRes[0].map(r => [r.product_id, r]));
            const supplierMap = new Map(suppliersRes[0].map(s => [s.id, String(s.verified_status).toLowerCase() === 'verified']));
            const promotedSet = new Set(promotedRes[0].map(p => p.product_id));
            const discountNameMap = new Map(discountNamesRes[0].map(d =>[String(d.product_id), d.name]));

            allProducts = allProducts.map(p => {
                const parsed = parseProduct(p);
                const rData = ratingMap.get(p.id) || { avg_rating: 0, review_count: 0 };
                
                return {
                    ...parsed,
                    isPromoted: promotedSet.has(p.id),
                    review_count: rData.review_count || 0, // Used for sorting
                    avg_rating: parseFloat(rData.avg_rating),
                    supplier_verified: supplierMap.get(p.supplier_id) || false,
                    has_video: !!parsed.video_url,
                    discount_label: discountNameMap.get(String(p.id)) || null
                };
            });
        }

        // --- 5. SMART SORTING ---
        if (showVerified === 'true') allProducts = allProducts.filter(p => p.supplier_verified);

        allProducts.sort((a, b) => {
            if (sort === 'newest') {
                // Section 1: Newest Arrivals (Strictly by Date)
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
            } else {
                // Section 2: All Recommended (Smart Ranking)
                
                // 1st Priority: Promoted Products
                if (a.isPromoted !== b.isPromoted) return b.isPromoted ? 1 : -1;
                
                // 2nd Priority: Most Reviewed Products
                if (b.review_count !== a.review_count) return b.review_count - a.review_count;
                
                // 3rd Priority: Most Viewed Products
                if (b.views !== a.views) return b.views - a.views;
                
                // 4th Priority: Newest Products
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
            }
        });

        // --- 6. PAGINATION IN JAVASCRIPT ---
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);
        
        res.status(200).json({ 
            products: paginatedProducts, 
            totalCount: page === 1 ? totalCount : undefined 
        });

    } catch (error) {
        console.error("Explore API Error:", error);
        res.status(500).json({ products:[], error: "Server Error" });
    }
};