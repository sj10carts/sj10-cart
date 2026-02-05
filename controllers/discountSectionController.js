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
    
    // 🔥 Attach the discount label so the frontend badge shows up!
    p.discount_label = discountName; 
    
    // Check for video
    p.has_video = (p.video_url && p.video_url.length > 5) || p.image_urls.some(u => u.includes('.mp4'));
    
    return p;
};

exports.getActiveDiscountSections = async (req, res) => {
    try {
        console.log("🔍 Checking for active discount sections...");

        // 1. Fetch Active Discounts (e.g., "Flash Deal") from MySQL
        const [discounts] = await db.inventory.query(
            "SELECT id, name FROM discounts WHERE is_active = 1 ORDER BY id DESC"
        );

        if (discounts.length === 0) {
            console.log("❌ No active discounts found.");
            return res.json([]); 
        }

        // 2. Loop through each discount and find its products
        const sectionsData = await Promise.all(discounts.map(async (discount) => {
            
            // Get Product IDs linked to this discount
            const [rows] = await db.inventory.query(
                "SELECT product_id FROM discount_products WHERE discount_id = ? LIMIT 12",
                [discount.id]
            );

            if (rows.length === 0) return null;

            const productIds = rows.map(r => String(r.product_id)); // Convert to String for Turso

            // 3. Fetch Product Details from Turso (Using General Shard for simplicity)
            // Note: In a full production app, you might check all shards, but checking 'shard_general' 
            // or iterating clients is safer if you don't know where products live.
            let rawProducts = [];
            
            // Try fetching from all shards to find these IDs
            const shardPromises = Object.values(clients).map(client => 
                client.execute({
                    sql: `SELECT id, title, slug, price, discounted_price, image_urls, video_url, supplier_id 
                          FROM products WHERE id IN (${productIds.map(()=>'?').join(',')})`,
                    args: productIds
                }).then(r => r.rows).catch(() => [])
            );

            const shardResults = await Promise.all(shardPromises);
            rawProducts = shardResults.flat();

            // 4. Enrich Products (Add Verified Status & Discount Label)
            if (rawProducts.length > 0) {
                const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))];
                const [suppliers] = await db.suppliers.query("SELECT id, verified_status FROM suppliers WHERE id IN (?)", [supplierIds.length ? supplierIds : [0]]);
                const supplierMap = new Map(suppliers.map(s => [String(s.id), s]));

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
                    title: discount.name, // e.g. "Flash Deal"
                    products: finalProducts
                };
            }
            return null;
        }));

        // Filter out empty sections
        const validSections = sectionsData.filter(s => s && s.products.length > 0);
        
        console.log(`✅ Sending ${validSections.length} discount sections.`);
        res.json(validSections);

    } catch (error) {
        console.error("Discount Section Error:", error);
        res.status(500).json([]);
    }
};

// ... existing getActiveDiscountSections code ...

// 🔥 NEW: Fetch Single Discount Page Data (Limit 100 products for now)
exports.getDiscountDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch Discount Info
        const [discount] = await db.inventory.query(
            "SELECT id, name, description FROM discounts WHERE id = ? AND is_active = 1",
            [id]
        );

        if (discount.length === 0) {
            return res.status(404).json({ message: "Discount not found or inactive" });
        }

        // 2. Fetch Linked Product IDs
        const [rows] = await db.inventory.query(
            "SELECT product_id FROM discount_products WHERE discount_id = ? LIMIT 100", 
            [id]
        );

        if (rows.length === 0) {
            return res.json({ ...discount[0], products: [] });
        }

        const productIds = rows.map(r => String(r.product_id));

        // 3. Fetch Product Data from Turso (Checking clients)
        const shardPromises = Object.values(clients).map(client => 
            client.execute({
                sql: `SELECT id, title, slug, price, discounted_price, image_urls, video_url, supplier_id 
                      FROM products WHERE CAST(id AS TEXT) IN (${productIds.map(()=>'?').join(',')})`,
                args: productIds
            }).then(r => r.rows).catch(() => [])
        );

        const shardResults = await Promise.all(shardPromises);
        let rawProducts = shardResults.flat();

        // 4. Enrich (Verified Badge & Discount Label)
        const supplierIds = [...new Set(rawProducts.map(p => p.supplier_id))];
        const [suppliers] = await db.suppliers.query("SELECT id, verified_status FROM suppliers WHERE id IN (?)", [supplierIds.length ? supplierIds : [0]]);
        const supplierMap = new Map(suppliers.map(s => [String(s.id), s]));

        const finalProducts = rawProducts.map(p => {
            // Re-use your parseProduct helper logic here or import it
            const parsed = { ...p }; 
            try { parsed.image_urls = typeof p.image_urls === 'string' ? JSON.parse(p.image_urls) : (p.image_urls || []); } catch(e) {}
            parsed.price = parseFloat(p.price);
            parsed.discounted_price = parseFloat(p.discounted_price || p.price);
            parsed.discount_label = discount[0].name; // Force label
            parsed.has_video = (p.video_url && p.video_url.length > 5);

            const sData = supplierMap.get(String(p.supplier_id));
            return {
                ...parsed,
                supplier_verified: sData && String(sData.verified_status) === 'verified'
            };
        });

        res.json({
            ...discount[0],
            products: finalProducts
        });

    } catch (error) {
        console.error("Single Discount Error:", error);
        res.status(500).json({ message: "Server Error" });
    }
};