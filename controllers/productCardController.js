// controllers/productCardController.js
const db = require('../config/database');
const { clients } = require('../config/tursoConnection');

/**
 * 🔥 LIGHTWEIGHT PRODUCT CARDS API
 * Optimized for: Zero Quota Usage, Lightning Fast CDN Caching (1 Month)
 */
exports.getProductCards = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 40; 
        const offset = (page - 1) * limit;
        
        // 🚀 SAFEST SHARD SELECTION: Agar wrong shard aaye toh crash nahi hoga
        const shardKey = req.query.shard;
        const client = (shardKey && clients[shardKey]) ? clients[shardKey] : clients.shard_general;

        const sql = `
            SELECT id, title, slug, sku, price, discounted_price, image_url, image_urls, video_url, supplier_id 
            FROM products 
            WHERE status = 'in_stock'
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `;
        const args = [limit, offset];

        const result = await client.execute({ sql, args });
        const rawProducts = result.rows;

        // 🚀 Agar page empty bhi ho, tab bhi Cache Header lagana zaroori hai!
        if (rawProducts.length === 0) {
            res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400');
            return res.json({ products: [], page, hasMore: false });
        }

        const productIds = rawProducts.map(p => p.id);
        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id).filter(Boolean))];
        
        let supplierMap = new Map();
        let ratingsMap = new Map();

        // 🚀 SAFE MYSQL QUERIES: Error handling add ki hai
        if (supplierIds.length > 0) {
            try {
                const [suppliers] = await db.suppliers.query("SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)", [supplierIds]);
                suppliers.forEach(s => {
                    supplierMap.set(String(s.id), {
                        isVerified: String(s.verified_status).toLowerCase() === 'verified',
                        brand: s.brand_name
                    });
                });
            } catch (supErr) {
                console.warn("⚠️ Supplier Map fetch failed in ProductCards:", supErr.message);
            }
        }

        if (productIds.length > 0 && db.reviews) {
            try {
                const [ratings] = await db.reviews.query("SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)", [productIds]);
                ratings.forEach(r => {
                    ratingsMap.set(String(r.product_id), { rating: parseFloat(r.avg_rating), count: parseInt(r.review_count) });
                });
            } catch (revErr) {
                console.warn("⚠️ Ratings Map fetch failed in ProductCards:", revErr.message);
            }
        }

        const optimizedProducts = rawProducts.map(p => {
            const sInfo = supplierMap.get(String(p.supplier_id)) || { isVerified: false, brand: 'Unknown' };
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
                sku: p.sku, 
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

        // 🔥 THE ULTIMATE 1-MONTH CACHE HEADER 🔥
        // s-maxage=2592000 (30 Days on Cloudflare)
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400');
        
        res.json({ 
            products: optimizedProducts, 
            page, 
            hasMore: rawProducts.length === limit 
        });
    } catch (error) {
        console.error("Product Cards API Error:", error.message);
        res.status(500).json({ message: "Error fetching cards" });
    }
};