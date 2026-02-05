// api/controllers/exploreController.js

const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

// Helper to clean up data types
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

        // --- 1. INTELLIGENT SHARD SELECTION ---
        const targetClients = shard && clients[shard] ? { [shard]: clients[shard] } : clients;

        // --- 2. BUILD TURSO QUERY ---
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

        // B. Get Raw Products
        const BUFFER_SIZE = limit * 4; 
        const productPromises = Object.values(targetClients).filter(c => c).map(c =>
            c.execute({ sql: `${baseSql} LIMIT ?`, args: [...queryArgs, BUFFER_SIZE] })
             .then(r => r.rows).catch(() => [])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // --- 4. ENRICHMENT (MySQL Data - Verified & DISCOUNTS) ---
        // This is the "Product Card Data Constructor" logic for the Cart Backend
        if (allProducts.length > 0) {
            const productIds = allProducts.map(p => p.id);
            const supplierIds = [...new Set(allProducts.map(p => p.supplier_id).filter(Boolean))];

            // 🔥 UPDATED: Added discountNamesRes to this Promise.all
            const [ratingsRes, suppliersRes, promotedRes, discountNamesRes] = await Promise.all([
                // 1. Ratings
                db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds]).catch(() => [[]]),
                // 2. Suppliers (For Verified Badge)
                db.suppliers.query(`SELECT id, verified_status FROM suppliers WHERE id IN (?)`, [supplierIds]).catch(() => [[]]),
                // 3. Promoted Status
                db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW()").catch(() => [[]]),
                
                // 4. 🔥 FETCH DISCOUNT NAMES (For Flash Sale Badge) 🔥
                db.inventory.query(`
                    SELECT dp.product_id, d.name 
                    FROM discount_products dp 
                    JOIN discounts d ON dp.discount_id = d.id 
                    WHERE d.is_active = 1 
                    AND dp.product_id IN (?)
                `, [productIds]).catch(() => [[]])
            ]);

            // Create Maps for O(1) Lookup
            const ratingMap = new Map(ratingsRes[0].map(r => [r.product_id, r]));
            // Supplier Map (Verified Logic)
            const supplierMap = new Map(suppliersRes[0].map(s => [s.id, String(s.verified_status).toLowerCase() === 'verified']));
            const promotedSet = new Set(promotedRes[0].map(p => p.product_id));
            
            // 🔥 Discount Map (Product ID -> Badge Name) 🔥
            // We use String() on IDs to ensure matching works between databases
            const discountNameMap = new Map(discountNamesRes[0].map(d => [String(d.product_id), d.name]));

            // Apply Data to Products
            allProducts = allProducts.map(p => {
                const parsed = parseProduct(p);
                const rData = ratingMap.get(p.id) || { avg_rating: 0, review_count: 0 };
                
                return {
                    ...parsed,
                    isPromoted: promotedSet.has(p.id),
                    review_count: rData.review_count,
                    avg_rating: parseFloat(rData.avg_rating),
                    
                    // Verified Badge Data
                    supplier_verified: supplierMap.get(p.supplier_id) || false,
                    
                    // Video Data
                    has_video: !!parsed.video_url,

                    // 🔥 SEND DISCOUNT LABEL TO FRONTEND 🔥
                    discount_label: discountNameMap.get(String(p.id)) || null
                };
            });
        }

        // --- 5. SORTING & PAGINATION ---
        if (showVerified === 'true') allProducts = allProducts.filter(p => p.supplier_verified);

        allProducts.sort((a, b) => {
            if (a.isPromoted !== b.isPromoted) return b.isPromoted ? 1 : -1;
            if (sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
            return b.views - a.views;
        });

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