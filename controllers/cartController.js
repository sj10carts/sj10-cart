const db = require('../config/database');
const { calculateDeliveryFee } = require('../utils/deliveryCalculator'); 
const { calculateCommission } = require('../utils/commissionCalculator');

// =========================================================
// 🚨 HELPER: Fetch Products directly from Oracle (Instead of Turso)
// =========================================================
const fetchProductsFromOracle = async (productIds) => {
    if (!productIds || productIds.length === 0) return [];
    const uniqueIds = [...new Set(productIds)].filter(Boolean);
    
    try {
        console.log(`🟢 [ORACLE DB] Cart fetching details for ${uniqueIds.length} products...`);
        const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(',');
        
        const res = await db.oracle.query(
            `SELECT id, title, price, discounted_price, image_urls, image_url, supplier_id, package_information, colors, sizes 
             FROM products WHERE id IN (${placeholders})`,
            uniqueIds
        );
        return res.rows || [];
    } catch (e) { 
        console.error("🔴 Oracle Fetch Products Error (Cart):", e.message);
        return []; 
    }
};

// =========================================================
// 🚨 HELPER: Fetch Variants directly from Oracle (Instead of Turso)
// =========================================================
const fetchVariantsFromOracle = async (variantIds) => {
    const uniqueIds = [...new Set(variantIds)]
        .filter(id => id && id !== 'null' && id !== 'undefined')
        .map(id => String(id).trim());
    
    if (uniqueIds.length === 0) return [];

    try {
        console.log(`🟢 [ORACLE DB] Cart fetching ${uniqueIds.length} variants...`);
        const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(',');
        
        const res = await db.oracle.query(
            `SELECT id, price, image_url, custom_color, custom_size 
             FROM variants 
             WHERE id IN (${placeholders})`,
            uniqueIds
        );
        return res.rows || [];
    } catch (e) { 
        console.error("🔴 Oracle Fetch Variants Error (Cart):", e.message);
        return []; 
    }
};

// =========================================================
// Main: Get Cart (Optimized for Oracle)
// =========================================================
exports.getCart = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 1. Get Cart Items from TiDB MySQL (Carts DB)
        const [cartItems] = await db.carts.query("SELECT * FROM cart WHERE user_id = ? ORDER BY created_at DESC", [userId]);

        if (cartItems.length === 0) return res.status(200).json([]);

        // Gather IDs
        const productIds = cartItems.map(item => item.product_id);
        const variantIds = [];
        
        cartItems.forEach((item) => {
            try {
                let opts = item.options;
                if (typeof opts === 'string') {
                    try { opts = JSON.parse(opts); } catch(e) {}
                }
                if (typeof opts === 'string') {
                    try { opts = JSON.parse(opts); } catch(e) {}
                }
                if (opts && opts.variantId) {
                    variantIds.push(opts.variantId);
                }
            } catch(e) {}
        });

        // 2. Fetch Details from Oracle (Instead of Turso Shards)
        const [products, variants] = await Promise.all([
            fetchProductsFromOracle(productIds),
            fetchVariantsFromOracle(variantIds)
        ]);

        const productMap = new Map(products.map(p => [String(p.id).trim(), p]));
        const variantMap = new Map(variants.map(v => [String(v.id).trim(), v]));

        // 3. Merge Data
        const processedCart = cartItems.map(item => {
            const product = productMap.get(String(item.product_id).trim());
            
            let parsedOptions = {};
            try { 
                parsedOptions = typeof item.options === 'string' ? JSON.parse(item.options) : item.options;
                if (typeof parsedOptions === 'string') parsedOptions = JSON.parse(parsedOptions);
            } catch (e) {}

            // Defaults from Product
            let unitPrice = parseFloat(product?.discounted_price || product?.price || 0);
            
            let imageUrls = [];
            try { 
                if (product?.image_urls) {
                    imageUrls = typeof product.image_urls === 'string' ? JSON.parse(product.image_urls) : product.image_urls; 
                } else if (product?.image_url) {
                    imageUrls = [product.image_url];
                }
            } catch (e) { imageUrls = []; }

            let finalColor = product?.colors ? String(product.colors).replace(/[\[\]"]/g, '') : "Standard";
            let finalSize = product?.sizes ? String(product.sizes).replace(/[\[\]"]/g, '') : "Standard";

            // Variant Overrides
            const vId = parsedOptions.variantId ? String(parsedOptions.variantId).trim() : null;
            
            if (vId) {
                const variant = variantMap.get(vId);
                if (variant) {
                    unitPrice = parseFloat(variant.price || unitPrice);
                    if (variant.image_url) {
                        imageUrls = [variant.image_url, ...imageUrls];
                    }
                    if (variant.custom_color && variant.custom_color !== 'null') {
                        finalColor = variant.custom_color;
                    }
                    if (variant.custom_size && variant.custom_size !== 'null') {
                        finalSize = variant.custom_size;
                    }
                } else {
                    if (parsedOptions.color && parsedOptions.color !== "Standard") finalColor = parsedOptions.color;
                    if (parsedOptions.size && parsedOptions.size !== "Standard") finalSize = parsedOptions.size;
                }
            } else {
                if (parsedOptions.color && parsedOptions.color !== "Standard") finalColor = parsedOptions.color;
                if (parsedOptions.size && parsedOptions.size !== "Standard") finalSize = parsedOptions.size;
            }

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
        console.error("🔴 GetCart Error:", error.message);
        res.status(500).json({ message: "Failed to fetch cart." });
    }
};

// 4. ADD ITEM TO CART (Standard TiDB MySQL)
exports.addItemToCart = async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId, quantity, options, profit } = req.body; 
        
        if (!productId || !quantity) return res.status(400).json({ message: "Missing fields" });

        const userProfit = parseFloat(profit) || 0;
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
        console.error("🔴 AddToCart Error:", error.message);
        res.status(500).json({ message: "Failed to add" });
    }
};

// 5. REMOVE ITEM FROM CART
exports.removeItemFromCart = async (req, res) => {
    try {
        await db.carts.execute("DELETE FROM cart WHERE id = ? AND user_id = ?", [req.params.cartItemId, req.user.id]);
        res.status(200).json({ message: "Removed" });
    } catch (error) {
        res.status(500).json({ message: "Failed" });
    }
};