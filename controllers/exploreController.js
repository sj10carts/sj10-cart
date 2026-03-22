// api/controllers/exploreController.js
const { clients } = require('../config/tursoConnection');
const db = require('../config/database');

exports.getExploreProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const offset = (page - 1) * limit;
        const { sort = 'smart_ranking', hasVideo, showVerified, shard } = req.query;

        // 1. Shard Selection
        const targetClients = shard && clients[shard] ? { [shard]: clients[shard] } : clients;

        // 2. Query top 150 items per shard (Strict Limit for performance)
        // This ensures we have enough data to sort by 'Most Reviews' without overloading Turso
        const baseSql = `SELECT id, title, slug, price, discounted_price, image_urls, video_url, views, supplier_id, created_at 
                         FROM products WHERE status = 'in_stock' ORDER BY created_at DESC LIMIT 150`;

        const productPromises = Object.values(targetClients)
            .filter(c => c !== null)
            .map(c => c.execute(baseSql).then(r => r.rows).catch(() => []));

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // If no products found, return immediately (prevents MySQL crash on empty IN (?) query)
        if (!allProducts || allProducts.length === 0) {
            return res.json({ products: [], totalCount: 0 });
        }

        // 3. Enrichment Data (Ratings, Suppliers, Promoted)
        const productIds = allProducts.map(p => p.id);
        const supplierIds = [...new Set(allProducts.map(p => p.supplier_id).filter(Boolean))];

        // Safety check for MySQL IN queries
        const ratingsPromise = (productIds.length > 0 && db.reviews) 
            ? db.reviews.query(`SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)`, [productIds]).catch(() => [[]])
            : Promise.resolve([[]]);

        const suppliersPromise = (supplierIds.length > 0 && db.suppliers)
            ? db.suppliers.query(`SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)`, [supplierIds]).catch(() => [[]])
            : Promise.resolve([[]]);

        const promotedPromise = (db.inventory)
            ? db.inventory.query("SELECT product_id FROM promoted_products WHERE payment_status='paid' AND end_date > NOW()").catch(() => [[]])
            : Promise.resolve([[]]);

        const [ratingsRes, suppliersRes, promotedRes] = await Promise.all([
            ratingsPromise,
            suppliersPromise,
            promotedPromise
        ]);

        const ratingMap = new Map(ratingsRes[0].map(r => [String(r.product_id), r]));
        const supplierMap = new Map(suppliersRes[0].map(s => [String(s.id), s]));
        const promotedSet = new Set(promotedRes[0].map(p => String(p.product_id)));

        // 4. Map to LITE format (Matches ProductCardLite exactly)
        let processed = allProducts.map(p => {
            const rData = ratingMap.get(String(p.id)) || { avg_rating: 0, review_count: 0 };
            const sData = supplierMap.get(String(p.supplier_id));
            
            let imgs = [];
            try { 
                imgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : p.image_urls; 
            } catch (e) { imgs = []; }

            const hasVideo = (p.video_url && p.video_url.length > 5) || 
                             (imgs && JSON.stringify(imgs).toLowerCase().includes('.mp4'));

            return {
                id: p.id,
                t: p.title,
                s: p.slug,
                p: parseFloat(p.price || 0),
                dp: parseFloat(p.discounted_price || p.price || 0),
                img: Array.isArray(imgs) ? imgs[0] : null,
                v: sData && String(sData.verified_status).toLowerCase() === 'verified',
                b: sData ? sData.brand_name : "SJ10",
                r: parseFloat(rData.avg_rating || 0),
                rc: parseInt(rData.review_count || 0),
                hv: hasVideo,
                isP: promotedSet.has(String(p.id)), // Promoted
                views: parseInt(p.views || 0),
                ts: new Date(p.created_at).getTime() // Timestamp for sorting
            };
        });

        // 5. Apply Business Logic Filters
        if (showVerified === 'true') processed = processed.filter(p => p.v);
        if (hasVideo === 'true') processed = processed.filter(p => p.hv);

        // 6. SMART SORTING (Promoted > Reviews > Views > Newest)
        processed.sort((a, b) => {
            if (sort === 'newest') return b.ts - a.ts;
            if (a.isP !== b.isP) return a.isP ? -1 : 1; 
            if (b.rc !== a.rc) return b.rc - a.rc;      
            if (b.views !== a.views) return b.views - a.views; 
            return b.ts - a.ts; 
        });

        const paginated = processed.slice(offset, offset + limit);
        
        // Cache the result for 1 hour to reduce DB hits
        res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
        res.status(200).json({ products: paginated, totalCount: processed.length });

    } catch (error) {
        console.error("Explore API Error:", error.message);
        res.status(500).json({ products: [], message: "Internal Server Error" });
    }
};