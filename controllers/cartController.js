const db = require('../config/database');
const { clients } = require('../config/tursoConnection');
const { calculateDeliveryFee } = require('../utils/deliveryCalculator'); 
const { calculateCommission } = require('../utils/commissionCalculator');

// =========================================================
// Helper: Fetch Products
// =========================================================
const fetchProductsFromTurso = async (productIds) => {
    if (!productIds || productIds.length === 0) return [];
    const uniqueIds = [...new Set(productIds)].filter(id => id);
    
    const promises = Object.values(clients).map(async (client) => {
        try {
            const placeholders = uniqueIds.map(() => '?').join(',');
            const res = await client.execute({
                sql: `SELECT id, title, price, discounted_price, image_urls, supplier_id, package_information, colors, sizes 
                      FROM products WHERE CAST(id AS TEXT) IN (${placeholders})`,
                args: uniqueIds.map(String)
            });
            return res.rows;
        } catch (e) { return []; }
    });
    return (await Promise.all(promises)).flat();
};

// =========================================================
// Helper: Fetch Variants
// =========================================================
const fetchVariantsFromTurso = async (variantIds) => {
    // 1. Clean IDs: Trim and remove nulls
    const uniqueIds = [...new Set(variantIds)]
        .filter(id => id && id !== 'null' && id !== 'undefined')
        .map(id => String(id).trim());
    
    if (uniqueIds.length === 0) {
        console.log("🛒 [Cart] No valid Variant IDs to fetch.");
        return [];69
    }

    console.log(`🛒 [Cart] Fetching Variants:`, uniqueIds);
    
    const promises = Object.entries(clients).map(async ([shardName, client]) => {
        if (!client) return [];
        try {
            const placeholders = uniqueIds.map(() => '?').join(',');
            const sql = `SELECT id, price, image_url, custom_color, custom_size 
                         FROM variants 
                         WHERE CAST(id AS TEXT) IN (${placeholders})`;

            const res = await client.execute({ sql, args: uniqueIds });
            
            if (res.rows.length > 0) {
                console.log(`✅ [Cart] Found ${res.rows.length} variants in ${shardName}`);
            }
            return res.rows;
        } catch (e) { 
            return []; 
        }
    });
    return (await Promise.all(promises)).flat();
};

// =========================================================
// Main: Get Cart
// =========================================================
exports.getCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const [cartItems] = await db.carts.query("SELECT * FROM cart WHERE user_id = ? ORDER BY created_at DESC", [userId]);

        if (cartItems.length === 0) return res.status(200).json([]);

        // 1. Gather IDs with Aggressive Parsing
        const productIds = cartItems.map(item => item.product_id);
        const variantIds = [];
        
        cartItems.forEach((item) => {
            try {
                let opts = item.options;
                
                // Handle Double-Stringified JSON (Common MySQL Issue)
                if (typeof opts === 'string') {
                    try { opts = JSON.parse(opts); } catch(e) {}
                }
                if (typeof opts === 'string') {
                    try { opts = JSON.parse(opts); } catch(e) {}
                }

                if (opts && opts.variantId) {
                    variantIds.push(opts.variantId);
                }
            } catch(e) {
                console.warn(`⚠️ Error parsing options for item ${item.id}`);
            }
        });

        // 2. Fetch Data from Turso
        const [products, variants] = await Promise.all([
            fetchProductsFromTurso(productIds),
            fetchVariantsFromTurso(variantIds)
        ]);

        const productMap = new Map(products.map(p => [String(p.id).trim(), p]));
        const variantMap = new Map(variants.map(v => [String(v.id).trim(), v]));

        console.log(`📊 [Cart Summary] Products: ${productMap.size}, Variants Found: ${variantMap.size}`);

        // 3. Merge Data
        const processedCart = cartItems.map(item => {
            const product = productMap.get(String(item.product_id).trim());
            
            // --- PARSE OPTIONS AGAIN FOR LOCAL USE ---
            let parsedOptions = {};
            try { 
                parsedOptions = typeof item.options === 'string' ? JSON.parse(item.options) : item.options;
                if (typeof parsedOptions === 'string') parsedOptions = JSON.parse(parsedOptions);
            } catch (e) {}

            // --- STEP A: Defaults from Product ---
            let unitPrice = parseFloat(product?.discounted_price || product?.price || 0);
            let imageUrls = [];
            try { 
                if (product?.image_urls) imageUrls = typeof product.image_urls === 'string' ? JSON.parse(product.image_urls) : product.image_urls; 
            } catch (e) {}

            // Product Defaults (Fallback)
            // We strip brackets/quotes just in case
            let finalColor = product?.colors ? String(product.colors).replace(/[\[\]"]/g, '') : "Standard";
            let finalSize = product?.sizes ? String(product.sizes).replace(/[\[\]"]/g, '') : "Standard";

            // --- STEP B: Variant Override (Highest Priority) ---
            const vId = parsedOptions.variantId ? String(parsedOptions.variantId).trim() : null;
            
            if (vId) {
                const variant = variantMap.get(vId);
                
                if (variant) {
                    // Override Price
                    unitPrice = parseFloat(variant.price || unitPrice);
                    
                    // Override Image
                    if (variant.image_url) {
                        imageUrls = [variant.image_url, ...imageUrls];
                    }

                    // ✅ FORCE VARIANT COLOR/SIZE (Source of Truth)
                    if (variant.custom_color && variant.custom_color !== 'null') {
                        finalColor = variant.custom_color;
                    }
                    if (variant.custom_size && variant.custom_size !== 'null') {
                        finalSize = variant.custom_size;
                    }
                } else {
                    console.warn(`⚠️ [Cart] Variant ID ${vId} in options but NOT found in DB. Using Product Fallback.`);
                    
                    // Priority 2: If Variant lookup failed, use saved cart options if they look valid
                    if (parsedOptions.color && parsedOptions.color !== "Standard") finalColor = parsedOptions.color;
                    if (parsedOptions.size && parsedOptions.size !== "Standard") finalSize = parsedOptions.size;
                }
            } else {
                // No Variant ID - Logic for standard products
                // If saved options exist, prefer them over global product defaults
                if (parsedOptions.color && parsedOptions.color !== "Standard") finalColor = parsedOptions.color;
                if (parsedOptions.size && parsedOptions.size !== "Standard") finalSize = parsedOptions.size;
            }

            // --- STEP C: Fees ---
            const deliveryFee = calculateDeliveryFee(product?.package_information || "");
            const commission = calculateCommission(unitPrice);

            return {
                cart_item_id: item.id,
                quantity: item.quantity,
                product_id: item.product_id,
                title: product?.title || 'Product Unavailable',
                price: unitPrice, 
                profit: parseFloat(item.profit) || 0,
                image_urls: imageUrls,
                options: {
                    ...parsedOptions,
                    color: finalColor,
                    size: finalSize
                },
                delivery_fee: deliveryFee,
                system_commission: commission
            };
        });

        res.status(200).json(processedCart);
    } catch (error) {
        console.error("GetCart Error:", error);
        res.status(500).json({ message: "Failed to fetch cart." });
    }
};

exports.addItemToCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId, quantity, options, profit } = req.body; 
        
        if (!productId || !quantity) return res.status(400).json({ message: "Missing fields" });

        const userProfit = parseFloat(profit) || 0;
        
        // ✅ CRITICAL: Ensure options are clean JSON
        let finalOptions = options;
        if (typeof options === 'string') {
            try { finalOptions = JSON.parse(options); } catch(e) { finalOptions = {}; }
        }

        const optionsString = JSON.stringify(finalOptions || {});

        const [existingItems] = await db.carts.query(
            "SELECT * FROM cart WHERE user_id = ? AND product_id = ? AND options = ?", 
            [userId, productId, optionsString]
        );

        if (existingItems.length > 0) {
            const item = existingItems[0];
            await db.carts.execute(
                "UPDATE cart SET quantity = quantity + ?, profit = ? WHERE id = ?", 
                [parseInt(quantity), userProfit, item.id]
            );
        } else {
            await db.carts.execute(
                "INSERT INTO cart (user_id, product_id, quantity, options, profit) VALUES (?, ?, ?, ?, ?)", 
                [userId, productId, parseInt(quantity), optionsString, userProfit]
            );
        }
        res.status(200).json({ message: "Added" });
    } catch (error) {
        console.error("AddToCart Error:", error);
        res.status(500).json({ message: "Failed to add" });
    }
};

exports.removeItemFromCart = async (req, res) => {
    try {
        await db.carts.execute("DELETE FROM cart WHERE id = ? AND user_id = ?", [req.params.cartItemId, req.user.id]);
        res.status(200).json({ message: "Removed" });
    } catch (error) {
        res.status(500).json({ message: "Failed" });
    }
};
exports.removeItemFromCart = async (req, res) => {
    try {
        await db.carts.execute("DELETE FROM cart WHERE id = ? AND user_id = ?", [req.params.cartItemId, req.user.id]);
        res.status(200).json({ message: "Removed" });
    } catch (error) {
        res.status(500).json({ message: "Failed" });
    }
};