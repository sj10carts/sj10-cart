// cart-backend/api/controllers/shopController.js
const db = require('../config/database');
const { clients } = require('../config/tursoConnection');

exports.getFollowedShops = async (req, res) => {
    try {
        const userId = req.user.id;
        const [follows] = await db.social.query(
            "SELECT supplier_id FROM supplier_followers WHERE user_id = ?", 
            [userId]
        );
        if (follows.length === 0) return res.status(200).json([]);
        const supplierIds = follows.map(f => f.supplier_id);
        const [shops] = await db.suppliers.query(
            `SELECT id, brand_name, profile_pic, verified_status FROM suppliers WHERE id IN (?)`,
            [supplierIds]
        );
        res.status(200).json(shops);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch followed shops" });
    }
};

// ✅ NEW: Chunked Product Fetching (Limit 40)
exports.getSupplierProducts = async (req, res) => {
    try {
        const { id } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 40; // Strict limit of 40
        const { sort = 'newest', search } = req.query;

        let baseSql = `SELECT id, title, slug, sku, price, discounted_price, image_urls, video_url, created_at 
                       FROM products WHERE status = 'in_stock' AND supplier_id = ?`;
        let queryArgs = [id];

        if (search) {
            baseSql += ` AND LOWER(title) LIKE ?`;
            queryArgs.push(`%${search.trim().toLowerCase()}%`);
        }

        // Fetch from all active shards
        const productPromises = Object.values(clients).filter(c => c).map(c =>
            c.execute({ sql: baseSql, args: queryArgs }).then(r => r.rows).catch(() => [])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // Sort Data server-side
        allProducts.sort((a, b) => {
            if (sort === 'price_low') return parseFloat(a.price) - parseFloat(b.price);
            if (sort === 'price_high') return parseFloat(b.price) - parseFloat(a.price);
            return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        });

        // Slice for Pagination (Lazy Loading)
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);

        res.status(200).json({ 
            products: paginatedProducts,
            hasMore: allProducts.length > offset + limit
        });

    } catch (error) {
        console.error("Supplier Products Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};