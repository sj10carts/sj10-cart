// controllers/productCardController.js
const db = require('../config/database');
const { clients } = require('../config/tursoConnection');

/**
 * 🔥 LIGHTWEIGHT PRODUCT CARDS API
 * Optimized for: Low Quota Usage, High Speed, and CDN Caching
 */
exports.getProductCards = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 40; 
        const offset = (page - 1) * limit;
        
        const shardKey = req.query.shard || 'shard_general';
        const client = clients[shardKey] || clients.shard_general;

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

        if (rawProducts.length === 0) {
            return res.json({ products: [], hasMore: false });
        }

        const productIds = rawProducts.map(p => p.id);
        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id).filter(Boolean))];
        
        let supplierMap = new Map();
        let ratingsMap = new Map();

        if (supplierIds.length > 0) {
            const [suppliers] = await db.suppliers.query("SELECT id, verified_status, brand_name FROM suppliers WHERE id IN (?)", [supplierIds]);
            suppliers.forEach(s => {
                supplierMap.set(String(s.id), {
                    isVerified: String(s.verified_status).toLowerCase() === 'verified',
                    brand: s.brand_name
                });
            });
        }

        if (productIds.length > 0 && db.reviews) {
            const [ratings] = await db.reviews.query("SELECT product_id, avg_rating, review_count FROM product_ratings WHERE product_id IN (?)", [productIds]);
            ratings.forEach(r => {
                ratingsMap.set(String(r.product_id), { rating: parseFloat(r.avg_rating), count: parseInt(r.review_count) });
            });
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

            return { id: p.id, t: p.title, s: p.slug, sku: p.sku, p: parseFloat(p.price), dp: parseFloat(p.discounted_price || p.price), img: finalImg, v: sInfo.isVerified, b: sInfo.brand, r: rInfo.rating, rc: rInfo.count, hv: hasVideo };
        });

        res.set('Cache-control', 'public, max-age=3600, s-maxage=864000, stale-while-revalidate=86400');
        res.json({ products: optimizedProducts, page, hasMore: rawProducts.length === limit });
    } catch (error) {
        res.status(500).json({ message: "Error fetching cards" });
    }
};