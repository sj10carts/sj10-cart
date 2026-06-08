// api/controllers/discountSectionController.js
const db = require('../config/database');
const { clients } = require('../config/tursoConnection');

// Helper to format product data
const parseProduct = (p, discountName) => {
    try {
        p.image_urls = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : (p.image_urls || []);
    } catch (e) { p.image_urls = []; }
    
    p.price = parseFloat(p.price);
    p.discounted_price = parseFloat(p.discounted_price || p.price);
    
    p.discount_label = discountName; 
    p.has_video = (p.video_url && p.video_url.length > 5) || p.image_urls.some(u => u.includes('.mp4'));
    
    return p;
};

// 🔥 1. GET ALL ACTIVE DISCOUNT SECTIONS (Homepage)
exports.getActiveDiscountSections = async (req, res) => {
    // 🚀 THE ULTIMATE 1-MONTH CACHE HEADER 
    const CACHE_HEADER = 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400';

    try {
        const [discounts] = await db.inventory.query(
            "SELECT id, name FROM discounts WHERE is_active = 1 ORDER BY id DESC"
        );

        if (discounts.length === 0) {
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json([]); 
        }

        const sectionsData = await Promise.all(discounts.map(async (discount) => {
            const [rows] = await db.inventory.query(
                "SELECT product_id FROM discount_products WHERE discount_id = ? LIMIT 12",
                [discount.id]
            );

            if (rows.length === 0) return null;
            const productIds = rows.map(r => String(r.product_id)); 

            let rawProducts = [];
            const shardPromises = Object.values(clients).map(client => 
                client.execute({
                    sql: `SELECT id, title, slug, price, discounted_price, image_urls, video_url, supplier_id 
                          FROM products WHERE id IN (${productIds.map(()=>'?').join(',')})`,
                    args: productIds
                }).then(r => r.rows).catch(() => [])
            );

            const shardResults = await Promise.all(shardPromises);
            rawProducts = shardResults.flat();

            if (rawProducts.length > 0) {
                const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))];
                let supplierMap = new Map();
                
                try {
                    const [suppliers] = await db.suppliers.query("SELECT id, verified_status FROM suppliers WHERE id IN (?)", [supplierIds.length ? supplierIds : [0]]);
                    supplierMap = new Map(suppliers.map(s => [String(s.id), s]));
                } catch(e) { console.warn("Supplier fetch failed in discounts:", e.message); }

                const finalProducts = rawProducts.map(p => {
                    const parsed = parseProduct(p, discount.name);
                    const sData = supplierMap.get(String(p.supplier_id));
                    return {
                        ...parsed,
                        supplier_verified: sData && String(sData.verified_status) === 'verified'
                    };
                });

                return {
                    section_id: discount.id,
                    title: discount.name, 
                    products: finalProducts
                };
            }
            return null;
        }));

        const validSections = sectionsData.filter(s => s && s.products.length > 0);
        
        // 🔥 Apply Cache Header before sending response
        res.setHeader('Cache-Control', CACHE_HEADER);
        res.json(validSections);

    } catch (error) {
        console.error("Discount Section Error:", error);
        res.status(500).json([]);
    }
};


// 🔥 2. GET SINGLE DISCOUNT PAGE DETAILS (Flash Sales Page)
exports.getDiscountDetails = async (req, res) => {
    const CACHE_HEADER = 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400';

    try {
        const { id } = req.params;

        const [discount] = await db.inventory.query(
            "SELECT id, name, description FROM discounts WHERE id = ? AND is_active = 1",
            [id]
        );

        if (discount.length === 0) {
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.status(404).json({ message: "Discount not found or inactive" });
        }

        const [rows] = await db.inventory.query(
            "SELECT product_id FROM discount_products WHERE discount_id = ? LIMIT 100", 
            [id]
        );

        if (rows.length === 0) {
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json({ ...discount[0], products: [] });
        }

        const productIds = rows.map(r => String(r.product_id));

        const shardPromises = Object.values(clients).map(client => 
            client.execute({
                sql: `SELECT id, title, slug, price, discounted_price, image_urls, video_url, supplier_id 
                      FROM products WHERE CAST(id AS TEXT) IN (${productIds.map(()=>'?').join(',')})`,
                args: productIds
            }).then(r => r.rows).catch(() => [])
        );

        const shardResults = await Promise.all(shardPromises);
        let rawProducts = shardResults.flat();

        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))];
        let supplierMap = new Map();
        
        try {
            const [suppliers] = await db.suppliers.query("SELECT id, verified_status FROM suppliers WHERE id IN (?)", [supplierIds.length ? supplierIds : [0]]);
            supplierMap = new Map(suppliers.map(s => [String(s.id), s]));
        } catch(e) { console.warn("Supplier fetch failed in discount detail:", e.message); }

        const finalProducts = rawProducts.map(p => {
            const parsed = { ...p }; 
            try { parsed.image_urls = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : (p.image_urls || []); } catch(e) {}
            parsed.price = parseFloat(p.price);
            parsed.discounted_price = parseFloat(p.discounted_price || p.price);
            parsed.discount_label = discount[0].name; 
            parsed.has_video = (p.video_url && p.video_url.length > 5);

            const sData = supplierMap.get(String(p.supplier_id));
            return {
                ...parsed,
                supplier_verified: sData && String(sData.verified_status) === 'verified'
            };
        });

        // 🔥 Apply Cache Header before sending response
        res.setHeader('Cache-Control', CACHE_HEADER);
        res.json({
            ...discount[0],
            products: finalProducts
        });

    } catch (error) {
        console.error("Single Discount Error:", error);
        res.status(500).json({ message: "Server Error" });
    }
};