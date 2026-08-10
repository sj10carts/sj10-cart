const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../config/database'); 

const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = require('../config/s3Client'); 
const https = require('https');

const redis = require('../config/redis'); // 🚨 Redis connection
const meiliPkg = require('meilisearch'); // 🚨 Meilisearch connection
const MeiliSearch = meiliPkg.Meilisearch || meiliPkg.MeiliSearch || meiliPkg.default || meiliPkg;

const meiliClient = new MeiliSearch({
    host: 'http://129.159.225.126:7700',
    apiKey: 'Sj10MeiliSuperKey2026'
});
// Optimized HTTPS Agent for persistent connections (Fast Scrape/Image Download)
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    keepAliveMsecs: 1000,
    rejectUnauthorized: false 
});

const toTitleCase = (str) => {
    if (!str || str.length < 3) return "";
    return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

// Generates a semi-transparent dark badge with a blue border and bold "SJ10" text
const createSJ10LogoSVG = (productWidth) => {
    const targetLogoWidth = Math.round(productWidth * 0.22); 
    const targetLogoHeight = Math.round(targetLogoWidth * 0.35); 
    return Buffer.from(`
        <svg width="${targetLogoWidth}" height="${targetLogoHeight}" viewBox="0 0 120 42" xmlns="http://www.w3.org/2000/svg">
            <rect width="120" height="42" rx="10" fill="#000000" fill-opacity="0.75" stroke="#3b82f6" stroke-width="2.5"/>
            <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="20" letter-spacing="1.5">SJ10</text>
        </svg>
    `);
};
// 🚨 HELPER FUNCTION: Guaranteed Unique SKU Generator (Oracle DB Only)
const getGuaranteedUniqueSku = async (markazCodeId) => {
    // Start with basic Markaz ID or timestamp
    const baseNumber = markazCodeId || Date.now().toString().slice(-6);
    let newSku = `SJ10-${baseNumber}`;
    let isUnique = false;

    while (!isUnique) {
        // Sirf Oracle DB mein check karega ke SKU pehle se tou nahi
        const check = await db.oracle.query("SELECT id FROM products WHERE sku = $1 LIMIT 1", [newSku]);
        
        if (check.rows.length === 0) {
            isUnique = true; // SKU Unique hai, loop khatam
        } else {
            // Agar SKU duplicate hai tou aage 4 random digits chipka dega (Bina extra dash ke)
            // Example: SJ10-659155 duplicate hai tou SJ10-6591557382 ban jayega
            const randomDigits = Math.floor(1000 + Math.random() * 9000).toString();
            newSku = `SJ10-${baseNumber}${randomDigits}`;
            console.log(`🔄 SKU Collision fixed! New SKU generated: ${newSku}`);
        }
    }
    
    return newSku;
};
// Filters out generic platform and marketplace marketing boilerplate
const isBoilerplate = (text) => {
    const lower = text.toLowerCase();
    return (
        lower.includes('markaz') || 
        lower.includes('reseller') || 
        lower.includes('wholesale') ||
        lower.includes('cash on delivery') ||
        lower.includes('shipping') ||
        lower.includes('refunds') ||
        lower.includes('return window') ||
        lower.includes('all rights reserved') ||
        lower.includes('terms & conditions') ||
        lower.includes('contact') ||
        lower.includes('about us') ||
        lower.includes('play store') ||
        lower.includes('made for pakistan')
    );
};

// 1. IMAGE PROCESSOR (Sharp + S3/R2 WebP converter)
const processAndUploadRemoteImage = async (imageUrl, sku, index) => {
    try {
        console.log(`      📸 [Image] Downloading: ${imageUrl.substring(0, 50)}...`);
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000,
            httpsAgent: httpsAgent,
            headers: { 'User-Agent': userAgents[0] }
        });
        
        const fileBuffer = Buffer.from(response.data);
        const metadata = await sharp(fileBuffer).metadata();
        const targetWidth = Math.min(metadata.width || 720, 720); 

        const logoSVG = createSJ10LogoSVG(targetWidth);
        const finalBuffer = await sharp(fileBuffer)
            .resize({ width: targetWidth, withoutEnlargement: true })
            .composite([{ input: logoSVG, gravity: 'southeast', offset: { right: 12, bottom: 12 } }])
            .webp({ quality: 65 }) 
            .toBuffer();

        const now = new Date();
        const fileKey = `product/${sku}/${sku}-${index}-${now.getTime()}.webp`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.CF_R2_BUCKET_NAME, Key: fileKey, Body: finalBuffer, ContentType: 'image/webp'
        }));
        
        console.log(`      ✅ [Image] Uploaded: ${fileKey}`);
        return `${process.env.CF_PUBLIC_URL}/${fileKey}`;
    } catch (error) {
        console.error(`      ❌ [Image Error] ${sku}: ${error.message}`);
        return null;
    }
};

// Dynamic database auto-scan for fetching categories
const fetchAllCategories = async () => {
    let categories = [];

    // Strategy A: Scan database keys to locate where the 'categories' table exists
    try {
        const dbKeys = Object.keys(db);
        console.log("🔍 [Categories Scan] Scanning database pools for 'categories' table...");
        
        for (const key of dbKeys) {
            const pool = db[key];
            if (pool && typeof pool.query === 'function' && key !== 'testAllConnections') {
                try {
                    const [rows] = await pool.query("SELECT id, name, parent_id, db_shard FROM categories ORDER BY name ASC");
                    if (rows && rows.length > 0) {
                        console.log(`🎯 [Success] Found 'categories' table in "db.${key}" pool! Loaded ${rows.length} rows.`);
                        return rows;
                    }
                } catch (err) {
                    // Silent catch, table not in this pool, continue scanning
                }
            }
        }
    } catch (scanErr) {
        console.log("⚠️ DB Dynamic Auto-Scan failed:", scanErr.message);
    }

    // Strategy B: Fallback to central Turso (shard_general) if core database query yields nothing
    try {
        if (clients && clients.shard_general) {
            const result = await clients.shard_general.execute({ sql: "SELECT id, name, parent_id, db_shard FROM categories" });
            if (result && result.rows && result.rows.length > 0) {
                console.log(`📚 [Categories Fallback] Fetched ${result.rows.length} rows from Turso shard_general`);
                return result.rows.map(r => ({
                    id: r.id,
                    name: r.name,
                    parent_id: r.parent_id,
                    db_shard: r.db_shard
                }));
            }
        }
    } catch (err) {
        console.log("⚠️ Turso shard_general check failed:", err.message);
    }

    console.log("❌ [Categories Scan] 'categories' table could not be found in any database pool.");
    return categories;
};

// 2. SCRAPE FUNCTION
exports.scrapeMarkaz = async (req, res) => {
    try {
        const { url } = req.body;

        // --- STEP 1: QUICK HANDSHAKE FOR FRONTEND CATEGORIES ---
        if (url === "https://www.markaz.app/" || !url) {
            const categories = await fetchAllCategories();
            return res.json({ categories });
        }

      const markazCodeId = (url.match(/\/(\d+)$/) || ["", ""])[1];

        // 1. Real Duplicate Check: Kya Markaz Code pehle se Oracle DB mein hai?
        if (markazCodeId) {
            const checkMarkaz = await db.oracle.query("SELECT id FROM products WHERE markaz_code = $1 LIMIT 1", [markazCodeId]);
            if (checkMarkaz.rows.length > 0) {
                console.log(`⚠️ [Scraper] Real Duplicate Markaz Code: ${markazCodeId}`);
                return res.status(400).json({ message: "Product already exists in system", isDuplicate: true });
            }
        }

        // 2. Safe Unique SKU Generator (Format: SJ10-RandomNumber)
        const generatedSku = await getGuaranteedUniqueSku(markazCodeId);

        const categories = await fetchAllCategories();
        
        const { data: html } = await axios.get(url, { 
            headers: { 'User-Agent': userAgents[0], 'Accept': 'text/html' },
            httpsAgent: httpsAgent,
            timeout: 10000 
        });
        const $ = cheerio.load(html);

        let title = "", salePrice = 0, originalPrice = 0, images = [], variants = [], description = "";

        try {
            const nextData = JSON.parse($('#__NEXT_DATA__').html());
            const product = nextData?.props?.pageProps?.product || nextData?.props?.pageProps?.initialData?.product;
            
            if (product) {
                title = product.title || "";
                salePrice = parseInt(product.price || 0);
                originalPrice = parseInt(product.oldPrice || 0);
                description = product.description || product.longDescription || "";
                
                if (product.images && Array.isArray(product.images)) {
                    images = product.images.map(img => {
                        if (typeof img === 'string') return img;
                        return img.url || img.src || img.original;
                    }).filter(url => url && url.includes('http'));
                }
            }
        } catch (e) { console.log("   ⚠️ JSON Parse skip..."); }

        if (images.length === 0) {
            const ogImg = $('meta[property="og:image"]').attr('content');
            if (ogImg) images.push(ogImg);

            $('img').each((i, el) => {
                const src = $(el).attr('src') || $(el).attr('data-src');
                if (src && src.includes('http') && !src.includes('logo') && !src.includes('icon') && src.includes('product')) {
                    images.push(src);
                }
            });
        }

        images = [...new Set(images)].filter(img => img.startsWith('http')).slice(0, 6);

        if (!title) title = $('h1').first().text().trim() || "Markaz Product";
        title = title.replace(/ – Markaz| - Markaz App/ig, '').trim();

        if (!salePrice) {
            const m = $('body').text().match(/PKR\s*([\d,]+)/i);
            if (m) salePrice = parseInt(m[1].replace(/,/g, ''));
        }

        // Deep Description Scanner (EXCLUDING Footers, Navbars, Headers, and Boilerplate)
        if (!description || description.length < 50) {
            let pTexts = [];
            $('p, span, div').not('footer *, nav *, header *, script, style, form *').each((i, el) => {
                const txt = $(el).text().trim();
                if (txt.length > 50 && txt.length < 1500 && !txt.includes('{') && !txt.includes('PKR')) {
                    if (!isBoilerplate(txt)) {
                        pTexts.push(txt);
                    }
                }
            });
            description = pTexts.sort((a, b) => b.length - a.length)[0] || "";
        }

        let specs = [];
        $('div, p, li, span').not('footer *, nav *, header *').each((i, el) => {
            const txt = $(el).text().trim();
            if (/^(Material|Texture|Skin Types|Color|Product Feature|Package Includes|Volume|Weight|Set Of|Note):\s*.+/i.test(txt)) {
                if (!isBoilerplate(txt)) {
                    specs.push(txt);
                }
            }
        });

        let finalDescription = (specs.length > 0 ? "Highlights:\n" + [...new Set(specs)].join('\n') + "\n\n" : "") + description;

        finalDescription = finalDescription
            .replace(/(?:product\s+)?code\s*:\s*[\w\d-]+/gi, '')
            .replace(/sku\s*:\s*[\w\d-]+/gi, '')
            .replace(/product\s+id\s*:\s*[\w\d-]+/gi, '')
            .replace(/\n\s*\n+/g, '\n\n') 
            .trim();

        let fColors = [], fSizes = [];
        $('div, span, label').not('footer *, nav *, header *').each((i, el) => {
            const txt = $(el).text().trim();
            if (/^(Color|Size)\s*:$/i.test(txt)) {
                $(el).parent().find('button, span').each((j, chip) => {
                    const val = $(chip).text().trim();
                    if (val && val.length < 20 && val !== txt && !val.includes('PKR') && val.length > 1) {
                        if (/Color/i.test(txt)) fColors.push(val); else fSizes.push(val);
                    }
                });
            }
        });

        fColors = [...new Set(fColors)]; fSizes = [...new Set(fSizes)];
        if (fColors.length > 0 && fSizes.length > 0) {
            fColors.forEach(c => fSizes.forEach(s => variants.push({ color: c, size: s, price: salePrice, image: images[0] })));
        } else if (fColors.length > 0) {
            fColors.forEach(c => variants.push({ color: c, size: '', price: salePrice, image: images[0] }));
        } else if (fSizes.length > 0) {
            fSizes.forEach(s => variants.push({ color: '', size: s, price: salePrice, image: images[0] }));
        } else {
            variants.push({ color: '', size: '', price: salePrice, image: images[0] });
        }

        console.log(`🔍 [Scraper] "${title.substring(0, 30)}..." | Images Found: ${images.length} | Variants: ${variants.length}`);

        res.json({
            title: toTitleCase(title), 
            salePrice: salePrice || 1000,
            cutPrice: originalPrice || Math.round((salePrice || 1000) * 1.2),
            images, 
            variants, 
            sku: generatedSku,
            description: finalDescription || "Premium Quality Product", 
            markaz_product_code: markazCodeId,
            categories: categories
        });

    } catch (e) { 
        console.error("❌ Scrape Error:", e.message);
        res.status(500).json({ message: "Scrape Failed" }); 
    }
};

exports.saveProduct = async (req, res) => {
    const { 
        title, sku, images, variants, selectedSupplierId, supplierId, supplier_id, 
        salePrice, cutPrice, categoryId, description, 
        markaz_product_code
    } = req.body;
    
    // 🚨 HARDCODED DEFAULT SUPPLIER ID (Agar frontend/token se na mile tou yeh use hogi)
    const DEFAULT_SUPPLIER_ID = "854ee7de-425b-4057-a8f7-eb310491c6b0";
    const finalSupplierId = supplierId || supplier_id || selectedSupplierId || req.user?.id || req.supplier?.id || DEFAULT_SUPPLIER_ID;

    console.log(`\n============================================`);
    console.log(`🚀 [ORACLE SAVE] STARTING | SKU: ${sku} | Markaz: ${markaz_product_code} | Supplier: ${finalSupplierId}`);
    console.log(`============================================`);

    try {
        // --- STEP 0: STRICT DUPLICATION CHECKS ---
        
        // A. Check Markaz Code in Oracle Postgres
        if (markaz_product_code) {
            const checkMarkaz = await db.oracle.query("SELECT id FROM products WHERE markaz_code = $1 LIMIT 1", [markaz_product_code]);
            if (checkMarkaz.rows.length > 0) {
                console.warn(`⚠️ [Save] ABORTED: Markaz Code ${markaz_product_code} already exists.`);
                return res.status(400).json({ message: "This Markaz product is already in our system!" });
            }
        }

        // B. (Agar Oracle Database mein manually sku unique check lagaya hua hai tou aap woh helper use kar sakte hain)

        // --- STEP 1: IMAGE PROCESSING ---
        console.log(`📸 [Step 1] Processing ${images?.length || 0} Images...`);
        const imageList = (images || []).slice(0, 4);
        const uploadPromises = imageList.map((img, idx) => processAndUploadRemoteImage(img, sku, idx + 1));
        const uploadedUrls = (await Promise.all(uploadPromises)).filter(url => url !== null);

        if (uploadedUrls.length === 0) {
            return res.status(400).json({ message: "Image upload failed. Cannot save product." });
        }

        const newId = uuidv4();
        const slug = (title || "prod").toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 70);
        const now = new Date().toISOString();

        // --- STEP 2: INSERT INTO ORACLE POSTGRES ---
        console.log(`🗄️ [Step 2] Inserting Main Product into Oracle...`);
        const productSql = `
            INSERT INTO products (
                id, supplier_id, category_id, title, description, price, discounted_price, quantity, 
                status, sku, slug, image_urls, image_url, created_at, markaz_code, imported_region
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `;

        // 🚨 Yahan $2 mein `finalSupplierId` paas ho raha hai taake exact ID Oracle mein save ho
        await db.oracle.query(productSql, [
            newId, finalSupplierId, categoryId || null, title, 
            description || "Premium Quality Product", 
            parseFloat(cutPrice || salePrice * 1.2), parseFloat(salePrice), 100, 'in_stock', sku, slug,
            JSON.stringify(uploadedUrls), uploadedUrls[0], now, markaz_product_code, "Pakistan"
        ]);

        // --- STEP 3: INSERT VARIANTS ---
        if (variants && variants.length > 0) {
            console.log(`🧬 [Step 3] Batch Inserting ${variants.length} Variants...`);
            const variantPromises = variants.map(v => 
                db.oracle.query(
                    `INSERT INTO variants (id, product_id, custom_color, custom_size, price, stock, sku, is_custom, image_url) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [uuidv4(), newId, v.color || null, v.size || null, parseFloat(v.price) || salePrice, 100, `${sku}-VAR`, 1, uploadedUrls[0]]
                )
            );
            await Promise.all(variantPromises);
        }

        // --- STEP 4: SYNC SEARCH ENGINE (MEILISEARCH) ---
        try {
            console.log(`🏎️ [Step 4] Pushing to Meilisearch...`);
            await meiliClient.index('products').addDocuments([{
                id: newId, title, slug, sku, description,
                price: parseFloat(salePrice), discounted_price: parseFloat(salePrice), created_at: now
            }]);
        } catch (meiliErr) { console.error("⚠️ [MEILI] Sync Warning:", meiliErr.message); }

        // --- STEP 5: HOUSEKEEPING (TiDB & Redis) ---
        // SKU views insert (agar aapka tidb chal raha hai tou)
        if (db.sku_master) {
            await db.sku_master.query("INSERT INTO sku_views (id, product_id, sku, slug, views) VALUES (?, ?, ?, ?, 0)", [uuidv4(), newId, sku, slug]).catch(e=>console.log(e.message));
        }
        
        // Supplier products count update
        await db.suppliers.execute("UPDATE suppliers SET total_products = total_products + 1 WHERE id = ?", [finalSupplierId]).catch(e=>console.log(e.message));
        
        // Cache clear
        await redis.del("homepage_master_cache_v5"); 

        console.log(`✅ [SUCCESS] Product Saved Globally! SKU: ${sku}`);
        res.json({ success: true, sku, slug });

    } catch (e) {
        console.error(`💥 [FATAL ERROR]:`, e.message);
        res.status(500).json({ message: "Internal Database Error" });
    }
};
// 4. BULK SAVE (ORACLE + BATCH SYNC + DUPE PROTECTION)
exports.bulkSaveProducts = async (req, res) => {
    const { products, categoryId, selectedSupplierId, supplierId, supplier_id } = req.body;
    
    // 🚨 HARDCODED DEFAULT SUPPLIER ID
    const DEFAULT_SUPPLIER_ID = "854ee7de-425b-4057-a8f7-eb310491c6b0";
    const finalSupplierId = supplierId || supplier_id || selectedSupplierId || req.user?.id || req.supplier?.id || DEFAULT_SUPPLIER_ID;
    
    console.log(`\n============================================`);
    console.log(`🚀 [BULK SAVE] STARTING for ${products.length} Products | Supplier: ${finalSupplierId}`);
    console.log(`============================================`);

    const savedSkus = [];
    const meiliDocs = [];

    try {
        for (const prod of products) {
            const { title, salePrice, sku, images, markaz_product_code } = prod;

            // 1. Strict Duplicate Pre-Check
            const checkDupe = await db.oracle.query("SELECT id FROM products WHERE markaz_code = $1 OR sku = $2 LIMIT 1", [markaz_product_code, sku]);
            if (checkDupe.rows.length > 0) {
                console.log(`⏭️ [Bulk] Skipping Duplicate: ${sku} / ${markaz_product_code}`);
                continue; 
            }

            // 2. Image Processing
            const uploadPromises = images.slice(0, 4).map((img, idx) => processAndUploadRemoteImage(img, sku, idx + 1));
            const uploadedUrls = (await Promise.all(uploadPromises)).filter(url => url !== null);
            if (uploadedUrls.length === 0) continue;

            const newId = uuidv4();
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 70);
            const now = new Date().toISOString();

            try {
                // 3. Oracle Insert (🚨 Yahan ab finalSupplierId use hoga)
                await db.oracle.query(
                    `INSERT INTO products (id, supplier_id, category_id, title, description, price, discounted_price, quantity, status, sku, slug, image_urls, image_url, created_at, markaz_code) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                    [newId, finalSupplierId, categoryId, title, "Premium Quality", parseFloat(salePrice * 1.2), parseFloat(salePrice), 100, 'in_stock', sku, slug, JSON.stringify(uploadedUrls), uploadedUrls[0], now, markaz_product_code]
                );

                // 4. Prepare for Meilisearch Batch
                meiliDocs.push({
                    id: newId, title, slug, sku, price: parseFloat(salePrice), 
                    discounted_price: parseFloat(salePrice), created_at: now
                });

                // 5. Reserve in SKU Master (TiDB)
                await db.sku_master.query("INSERT INTO sku_views (id, product_id, sku, slug, views) VALUES (?, ?, ?, ?, 0)", [uuidv4(), newId, sku, slug]);
                
                savedSkus.push(sku);
                console.log(`✅ [Bulk] Saved: ${sku}`);

            } catch (innerErr) {
                console.error(`❌ [Bulk] Failed item ${sku}:`, innerErr.message);
            }
        }

        // --- FINAL BATCH SYNC ---
        if (meiliDocs.length > 0) {
            console.log(`🏎️ [Bulk] Batch indexing ${meiliDocs.length} items in Meilisearch...`);
            await meiliClient.index('products').addDocuments(meiliDocs);
        }

        // Update Supplier Total Count & Flush Cache (🚨 Yahan bhi finalSupplierId use hoga)
        if (savedSkus.length > 0) {
            await db.suppliers.execute("UPDATE suppliers SET total_products = total_products + ? WHERE id = ?", [savedSkus.length, finalSupplierId]);
            await redis.del("homepage_master_cache_v5");
        }

        console.log(`🏁 [BULK COMPLETE] Saved: ${savedSkus.length} / Total: ${products.length}`);
        res.json({ success: true, savedCount: savedSkus.length });

    } catch (e) {
        console.error(`💥 [Bulk Fatal]:`, e.message);
        res.status(500).json({ message: "Bulk operation failed." });
    }
};

exports.getTeam = async (req, res) => {
    try {
        const [rows] = await db.suppliers.query("SELECT id, brand_name FROM suppliers WHERE status = 'active'");
        res.json(rows);
    } catch (e) { res.status(500).json({ message: "Error" }); }
};

// 5. GLOBAL COUNTER SYNC (ORACLE POSTGRES)
exports.syncAllSuppliersProductCounts = async (req, res) => {
    try {
        console.log("🟢 [ORACLE DB] Syncing global supplier product counters...");
        
        // Single Group By Query in Postgres (Lightning Fast)
        const result = await db.oracle.query(
            "SELECT supplier_id, COUNT(*) as total_count FROM products GROUP BY supplier_id"
        );

        const syncPromises = result.rows.map(row => {
            if (row.supplier_id) {
                return db.suppliers.execute(
                    "UPDATE suppliers SET total_products = ? WHERE id = ?", 
                    [parseInt(row.total_count), row.supplier_id]
                );
            }
            return null;
        }).filter(Boolean);

        await Promise.all(syncPromises);
        res.json({ success: true, message: "Counters synced via Oracle Postgres!" });
    } catch (e) { res.status(500).json({ message: "Sync Failed: " + e.message }); }
};
// Log diagnostic keys on startup
console.log("====================================");
console.log("🔍 [SJ10 DB Diagnostic] Loaded backend with database fallbacks.");
console.log("====================================");

// =========================================================================
// 🚨 NEW AUTOMATED SYNC ENGINE FOR AUTO-UPDATE (Oracle + Redis + Meili) 🚨
// =========================================================================

// 1. GET UNSYNCED PRODUCTS (SKIP LOCKED - Prevents Multi-Tab Conflict)
exports.getUnsyncedProducts = async (req, res) => {
    try {
        console.log("🟢 [Oracle] Allocating 50 products with strict locking...");

        // Select 50 oldest synced rows and lock them instantly for this thread
        const lockQuery = `
            UPDATE products
            SET last_synced_at = NOW()
            WHERE id IN (
                SELECT id FROM products
                WHERE status = 'in_stock' AND markaz_code IS NOT NULL
                ORDER BY last_synced_at ASC NULLS FIRST
                LIMIT 50
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, title, sku, markaz_code, markaz_url;
        `;

        const result = await db.oracle.query(lockQuery);
        res.json(result.rows);
    } catch (error) {
        console.error("🔴 Get Unsynced Error:", error.message);
        res.status(500).json([]);
    }
};

// 2. SYNC SINGLE PRODUCT (Verify Stock & Price + Sync Meili/Redis/Variants)
exports.updateSingleProduct = async (req, res) => {
    try {
        const { productId, markaz_code, currentUrl } = req.body;

        if (!productId || !markaz_code) return res.status(400).json({ message: "Missing data" });

        let targetUrl = currentUrl;
        if (!targetUrl || targetUrl === 'null' || targetUrl.trim() === '') {
            targetUrl = `https://www.markaz.app/shop/product/product/${markaz_code}`;
        }

        const { data: html } = await axios.get(targetUrl, { 
            headers: { 'User-Agent': userAgents[0], 'Accept': 'text/html' },
            httpsAgent: httpsAgent,
            timeout: 10000 
        });
        const $ = cheerio.load(html);

        let title = "", salePrice = 0, originalPrice = 0, description = "", inStock = true;

        try {
            const nextData = JSON.parse($('#__NEXT_DATA__').html());
            const product = nextData?.props?.pageProps?.product || nextData?.props?.pageProps?.initialData?.product;
            
            if (product) {
                title = product.title || "";
                salePrice = parseInt(product.price || 0);
                originalPrice = parseInt(product.oldPrice || 0);
                description = product.description || product.longDescription || "";
                // NextData stock check
                inStock = product.status !== 'out_of_stock' && product.quantity > 0;
            }
        } catch (e) {}

        if (!title) title = $('h1').first().text().trim();
        if (!salePrice) {
            const m = $('body').text().match(/PKR\s*([\d,]+)/i);
            if (m) salePrice = parseInt(m[1].replace(/,/g, ''));
        }
        
        // 🚨 THE CRITICAL FIX: Ignore disabled size chips. 🚨
        // Only look at the main "Add to bag" or "Out of stock" action buttons.
        const mainOutOfStockBtn = $('button').filter(function() {
            const text = $(this).text().toLowerCase();
            return text.includes('out of stock') || text.includes('sold out');
        }).length > 0;

        const buyBtnExists = $('button:contains("Add to bag"), button:contains("Buy now")').length > 0;

        // If main out-of-stock button is active OR main buy buttons are missing entirely
        if (mainOutOfStockBtn || (!buyBtnExists && title)) {
            inStock = false;
        }

        if (!title || !salePrice) {
            // Product deleted on Markaz, set to out of stock
            await db.oracle.query("UPDATE products SET status = 'out_of_stock', quantity = 0, last_synced_at = NOW() WHERE id = $1", [productId]);
            await db.oracle.query("UPDATE variants SET stock = 0 WHERE product_id = $1", [productId]); // Update variants
            return res.json({ status: "DELETED_ON_MARKAZ", message: "Out of Stock" });
        }

        const calculatedStatus = inStock ? 'in_stock' : 'out_of_stock';
        const calculatedQty = inStock ? 100 : 0;
        const finalTitle = toTitleCase(title.replace(/ – Markaz| - Markaz App/ig, '').trim());

     // 🚨 ONLY UPDATE PRICE & STOCK (Title, Description, and Images are 100% Protected!)
        const updateSql = `
            UPDATE products 
            SET price = $1, discounted_price = $2, quantity = $3, status = $4, 
                markaz_url = $5, last_synced_at = NOW() 
            WHERE id = $6
        `;

        await db.oracle.query(updateSql, [
            originalPrice || Math.round(salePrice * 1.2), 
            salePrice, 
            calculatedQty, 
            calculatedStatus, 
            targetUrl, 
            productId
        ]);

        // B. 🧬 SYNC ALL VARIANTS' STOCK (TiDB & Oracle Postgres Sync)
        // Agar main product out of stock ho jaye tou saare variants automatic 0 stock ho jayenge!
        await db.oracle.query("UPDATE variants SET stock = $1 WHERE product_id = $2", [calculatedQty, productId]);

        // C. Sync Meilisearch
        try {
            const slug = finalTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 70);
            await meiliClient.index('products').addDocuments([{
                id: productId, title: finalTitle, slug, price: parseFloat(salePrice), discounted_price: parseFloat(salePrice)
            }]);
        } catch(e) {}

        // D. Flush Redis
        await redis.del("homepage_master_cache_v5");

        res.json({ status: "SUCCESS", title: finalTitle, price: salePrice, stock: calculatedStatus });

    } catch (error) {
        res.status(500).json({ status: "FAILED", message: error.message });
    }
};