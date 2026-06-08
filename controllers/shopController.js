// cart-backend/api/controllers/shopController.js
const db = require('../config/database');
const { clients } = require('../config/tursoConnection');

// 🚫 DO NOT CACHE THIS (Personal User Data)
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
        
        // Ensure no cache for private routes
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json(shops);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch followed shops" });
    }
};

// 🔥 CACHE THIS (Public Supplier Store Products)
exports.getSupplierProducts = async (req, res) => {
    try {
        const { id } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 40; 
        const { sort = 'newest', search } = req.query;

        // 🚀 OPTIMIZATION 1: Database Level Limit
        const fetchLimit = page * limit;

        let baseSql = `SELECT id, title, slug, sku, price, discounted_price, image_url, image_urls, video_url, created_at 
                       FROM products WHERE status = 'in_stock' AND supplier_id = ?`;
        let queryArgs = [id];

        if (search) {
            baseSql += ` AND LOWER(title) LIKE ?`;
            queryArgs.push(`%${search.trim().toLowerCase()}%`);
        }

        // Apply strict DB limit to protect server memory
        baseSql += ` ORDER BY created_at DESC LIMIT ${fetchLimit}`;

        // Fetch from all active shards
        const productPromises = Object.values(clients).filter(c => c).map(c =>
            c.execute({ sql: baseSql, args: queryArgs }).then(r => r.rows).catch(() => [])
        );

        const results = await Promise.all(productPromises);
        let allProducts = results.flat();

        // Sort Data server-side (for multi-shard merging)
        allProducts.sort((a, b) => {
            if (sort === 'price_low') return parseFloat(a.price) - parseFloat(b.price);
            if (sort === 'price_high') return parseFloat(b.price) - parseFloat(a.price);
            return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        });

        // Slice for Pagination (Lazy Loading)
        const offset = (page - 1) * limit;
        const paginatedProducts = allProducts.slice(offset, offset + limit);

        // Map to standard format & check for videos
        const finalProducts = paginatedProducts.map(p => {
            let finalImg = p.image_url;
            let hasVideo = false;

            try {
                const parsedImgs = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : p.image_urls;
                if (Array.isArray(parsedImgs) && parsedImgs.length > 0) finalImg = parsedImgs[0];
                if (typeof p.image_urls === 'string' && p.image_urls.includes('.mp4')) hasVideo = true;
            } catch(e) {}
            
            if (p.video_url && p.video_url.length > 5) hasVideo = true;

            // Optional: Format to LiteCard structure if your frontend expects it
            return {
                ...p,
                image_urls: finalImg ? [finalImg] : [],
                image_url: finalImg,
                has_video: hasVideo
            };
        });

        // 🚀 OPTIMIZATION 2: THE 1-MONTH CACHE HEADER
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400');

        res.status(200).json({ 
            products: finalProducts,
            hasMore: allProducts.length > offset + limit
        });

    } catch (error) {
        console.error("Supplier Products Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};