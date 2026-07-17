const db = require('../config/database');

// --- Helper to format product data ---
const parseProduct = (p, discountName) => {
    let images = [];
    try {
        if (Array.isArray(p.image_urls)) {
            images = p.image_urls;
        } else if (typeof p.image_urls === 'string' && p.image_urls.startsWith('[')) {
            images = JSON.parse(p.image_urls);
        } else {
            images = [p.image_url || p.image_urls].filter(Boolean);
        }
    } catch (e) { 
        images = [p.image_url].filter(Boolean); 
    }
    
    p.image_urls = images.length > 0 ? images : ["/placeholder.jpg"];
    p.price = parseFloat(p.price || 0);
    p.discounted_price = parseFloat(p.discounted_price || p.price || 0);
    
    p.discount_label = discountName; 
    p.has_video = (p.video_url && p.video_url.length > 5) || p.image_urls.some(u => typeof u === 'string' && u.includes('.mp4'));
    
    return p;
};

// --- Helper: Fetch Products directly from Oracle ---
const fetchProductsFromOracle = async (productIds) => {
    if (!productIds || productIds.length === 0) return [];
    try {
        console.log(`🟢 [ORACLE DB] Discounts fetching ${productIds.length} products...`);
        const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
        
        const res = await db.oracle.query(
            `SELECT id, title, slug, price, discounted_price, image_urls, image_url, video_url, supplier_id 
             FROM products WHERE id IN (${placeholders})`,
            productIds
        );
        return res.rows || [];
    } catch (e) { 
        console.error("🔴 Oracle Fetch Discounted Products Error:", e.message);
        return []; 
    }
};

// ======================================================
// 🔥 1. GET ALL ACTIVE DISCOUNT SECTIONS (Homepage)
// ======================================================
exports.getActiveDiscountSections = async (req, res) => {
    const CACHE_HEADER = 'public, max-age=3600, s-maxage=2592000, stale-while-revalidate=86400';

    try {
        // Fetch active campaigns from TiDB MySQL (Inventory DB)
        const [discounts] = await db.inventory.query(
            "SELECT id, name FROM discounts WHERE is_active = 1 ORDER BY id DESC"
        );

        if (discounts.length === 0) {
            res.setHeader('Cache-Control', CACHE_HEADER);
            return res.json([]); 
        }

        // Loop campaigns and fetch products from Oracle
        const sectionsData = await Promise.all(discounts.map(async (discount) => {
            const [rows] = await db.inventory.query(
                "SELECT product_id FROM discount_products WHERE discount_id = ? LIMIT 12",
                [discount.id]
            );

            if (rows.length === 0) return null;
            const productIds = rows.map(r => String(r.product_id)); 

            // 🚨 FETCH DIRECTLY FROM ORACLE
            const rawProducts = await fetchProductsFromOracle(productIds);

            if (rawProducts.length > 0) {
                const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))].filter(Boolean);
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
        
        res.setHeader('Cache-Control', CACHE_HEADER);
        res.json(validSections);

    } catch (error) {
        console.error("🔴 Discount Section Error:", error.message);
        res.status(500).json([]);
    }
};

// ======================================================
// 🔥 2. GET SINGLE DISCOUNT PAGE DETAILS (Flash Sales Page)
// ======================================================
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

        // 🚨 FETCH DIRECTLY FROM ORACLE
        const rawProducts = await fetchProductsFromOracle(productIds);

        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))].filter(Boolean);
        let supplierMap = new Map();
        
        try {
            const [suppliers] = await db.suppliers.query("SELECT id, verified_status FROM suppliers WHERE id IN (?)", [supplierIds.length ? supplierIds : [0]]);
            supplierMap = new Map(suppliers.map(s => [String(s.id), s]));
        } catch(e) { console.warn("Supplier fetch failed in discount detail:", e.message); }

        const finalProducts = rawProducts.map(p => {
            const parsed = parseProduct(p, discount[0].name);
            const sData = supplierMap.get(String(p.supplier_id));
            return {
                ...parsed,
                supplier_verified: sData && String(sData.verified_status) === 'verified'
            };
        });

        res.setHeader('Cache-Control', 'CACHE_HEADER');
        res.json({
            ...discount[0],
            products: finalProducts
        });

    } catch (error) {
        console.error("🔴 Single Discount Error:", error.message);
        res.status(500).json({ message: "Server Error" });
    }
};