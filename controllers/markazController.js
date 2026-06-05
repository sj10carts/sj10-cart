// controllers/markazController.js (Carts Backend)
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../config/database'); 
const { clients } = require('../config/tursoConnection'); 
const { v4: uuidv4 } = require('uuid');

const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = require('../config/s3Client'); 

const toTitleCase = (str) => {
    if (!str || str.length < 3) return "";
    return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

const createSJ10LogoSVG = (productWidth) => {
    const targetLogoWidth = Math.round(productWidth * 0.22); 
    const targetLogoHeight = Math.round(targetLogoWidth * 0.35); 
    const svg = `
    <svg width="${targetLogoWidth}" height="${targetLogoHeight}" viewBox="0 0 120 42" xmlns="http://www.w3.org/2000/svg">
        <rect width="120" height="42" rx="12" fill="#000000" fill-opacity="0.65" stroke="#3b82f6" stroke-width="2.5"/>
        <path d="M 23 15 C 23 11, 14 11, 14 15 C 14 18, 23 18, 23 21 C 23 25, 14 25, 14 21" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="50" y="13" width="11" height="13" rx="4" fill="none" stroke="#3b82f6" stroke-width="4"/>
    </svg>`;
    return Buffer.from(svg);
};

const getDateTimeStrings = () => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
    return { dateStr, timeStr };
};

const processAndUploadRemoteImage = async (imageUrl, sku, index) => {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(response.data);
        const metadata = await sharp(fileBuffer).metadata();
        const targetWidth = Math.min(metadata.width, 720); 

        const logoSVG = createSJ10LogoSVG(targetWidth);
        let finalBuffer;
        try {
            finalBuffer = await sharp(fileBuffer)
                .resize({ width: targetWidth, withoutEnlargement: true })
                .composite([{ input: logoSVG, gravity: 'southeast', offset: { right: 12, bottom: 12 } }])
                .webp({ quality: 55, effort: 3 }) 
                .toBuffer();
        } catch (compErr) {
            finalBuffer = await sharp(fileBuffer)
                .resize({ width: targetWidth, withoutEnlargement: true })
                .webp({ quality: 55, effort: 3 }) 
                .toBuffer();
        }

        const { dateStr, timeStr } = getDateTimeStrings();
        const fileKey = `product/${sku}/${sku}-${index}-${dateStr}-${timeStr}.webp`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.CF_R2_BUCKET_NAME,
            Key: fileKey,
            Body: finalBuffer,
            ContentType: 'image/webp',
            ACL: 'public-read',
        }));
        return `${process.env.CF_PUBLIC_URL}/${fileKey}`;
    } catch (error) {
        console.error(`💥 Image Process & Upload Error [${imageUrl}]:`, error.message);
        return null;
    }
};

// 🎯 SCRAPE FUNCTION (100% DYNAMIC HIGHLIGHTS & DEEP PARAGRAPHS SCANNER)
exports.scrapeMarkaz = async (req, res) => {
    try {
        const { url } = req.body;
        const markazCodeId = (url.match(/\/(\d+)$/) || ["", ""])[1];

        // Using db.sku_master to check existing SKU
        if (markazCodeId && db.sku_master) {
            try {
                const [existing] = await db.sku_master.query("SELECT sku FROM sku_views WHERE sku LIKE ?", [`%${markazCodeId}%`]);
                if (existing && existing.length > 0) {
                    return res.status(400).json({ already_scraped: true, message: `❌ This Markaz Product is already scraped!\nIt is already saved in your database with SKU: ${existing[0].sku}` });
                }
            } catch (dbErr) {
                console.warn("⚠️ [Scrape DB Check Warning] Indexing DB not connected. Skipping duplicate check. Error:", dbErr.message);
            }
        }

        const selectedUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': selectedUserAgent, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' }
        });

        const $ = cheerio.load(html);
        let source = html.replace(/\\\\/g, '\\').replace(/\\"/g, '"');

        let title = "";
        let description = "";
        let productCode = "";
        let salePrice = 0;
        let originalPrice = 0;
        let images = [];

        // 🚀 1. NEXT.JS HYDRATION PARSER (Safe Navigation)
        try {
            const nextDataScript = $('#__NEXT_DATA__').html();
            if (nextDataScript) {
                const nextData = JSON.parse(nextDataScript);
                const props = nextData?.props?.pageProps;
                const product = props?.product || props?.productDetails || props?.initialData?.product;
                
                if (product) {
                    title = product.title || product.name || "";
                    productCode = product.productCode || product.code || "";
                    salePrice = parseInt(product.price || 0);
                    originalPrice = parseInt(product.oldPrice || 0);
                    
                    if (product.images && Array.isArray(product.images)) {
                        images = product.images.map(img => typeof img === 'string' ? img : (img.url || img.src || ''));
                    }

                    const rawDesc = product.description || product.longDescription || "";
                    if (rawDesc && !rawDesc.includes('"@context"') && !rawDesc.startsWith('{')) {
                        description = rawDesc.trim();
                    }
                }
            }
        } catch (jsonErr) {}

        // =================================================================
        // 🟢 2. DYNAMIC SPECIFICATION/HIGHLIGHTS EXTRACTOR (Fashion Friendly)
        // =================================================================
        // Yeh kisi bhi "Label: Value" format (e.g. Shirt Fabric: Organza) ko automatic utha lega
        let specs = [];
        $('div, p, li, span').each((i, el) => {
            if ($(el).children().length === 0) {
                const txt = $(el).text()?.trim() || "";
                if (/^[A-Za-z0-9\s/'-]+:\s*(.+)/.test(txt)) {
                    // Exclude standard false positives
                    if (!txt.includes('Product Code') && 
                        !txt.includes('PKR') && 
                        !txt.includes('Add to bag') && 
                        !txt.includes('Charges') &&
                        !txt.includes('Delivery') &&
                        !txt.includes('Note:')) {
                        specs.push(txt);
                    }
                }
            }
        });
        const cleanSpecs = [...new Set(specs)].join('\n');

        // =================================================================
        // 🟢 3. DEEP PARAGRAPHS SCANNER (Main long description text)
        // =================================================================
        let paragraphs = [];
        $('p, div, span').each((i, el) => {
            if ($(el).children().length === 0) {
                const txt = $(el).text()?.trim() || "";
                if (txt.length > 50 && txt.length < 1500) {
                    if (!txt.includes('{') && 
                        !txt.includes('PKR') && 
                        !txt.includes('Add to bag') && 
                        !txt.includes('similar products') && 
                        !txt.includes('You might also like') && 
                        !txt.includes('Delivery') && 
                        !txt.includes('Charges') && 
                        !txt.includes('Return allowed') && 
                        !txt.includes('Show more') &&
                        !/^[A-Za-z0-9\s/'-]+:\s*(.+)/.test(txt)) { // Exclude key-value specs
                        paragraphs.push(txt);
                    }
                }
            }
        });
        const cleanDescBody = [...new Set(paragraphs)].slice(0, 3).join('\n\n');

        // =================================================================
        // 🟢 4. MERGE EVERYTHING INTO A BEAUTIFUL DESCRIPTION
        // =================================================================
        let finalDescription = "";
        if (cleanSpecs) {
            finalDescription += "Highlights:\n" + cleanSpecs + "\n\n";
        }
        if (cleanDescBody) {
            finalDescription += cleanDescBody;
        } else if (description) {
            finalDescription += description;
        } else {
            finalDescription += "Premium quality product.";
        }

        // Clean out codes or leftovers
        finalDescription = finalDescription.replace(/Product Code:\s*[A-Z0-9]+/gi, '').trim();
        finalDescription = finalDescription.replace(/MZ[A-Z0-9]{12,20}/gi, '').trim();

        if (!title) {
            title = $('meta[property="og:title"]').attr('content') || $('title').text() || "";
            title = title.replace(/ – Markaz| - Markaz App/ig, '').trim();
        }

        // =================================================================
        // 🟢 5. SMART RETAIL PRICE OVERRIDE
        // =================================================================
        let displayPrice = 0;
        $('*').each((i, el) => {
            if ($(el).children().length === 0) {
                const text = $(el).text().trim();
                const match = text.match(/^(?:PKR|Rs\.?)\s*([\d,]+)$/i);
                if (match) {
                    const val = parseInt(match[1].replace(/,/g, ''));
                    if (val > 250 && val !== 165) {
                        if (!displayPrice) displayPrice = val;
                    }
                }
            }
        });

        if (displayPrice) { salePrice = displayPrice; }

        if (salePrice && !originalPrice) {
            originalPrice = salePrice + Math.floor(salePrice * 0.15); 
        }
        if (salePrice > originalPrice && originalPrice > 0) {
            let temp = salePrice; salePrice = originalPrice; originalPrice = temp;
        }

        if (!salePrice) salePrice = 1000;
        if (!originalPrice) originalPrice = salePrice + Math.floor(salePrice * 0.15);

        if (images.length === 0) {
            const ogImg = $('meta[property="og:image"]').attr('content');
            if (ogImg && !ogImg.toLowerCase().includes('logo')) images.push(ogImg);
        }

        let localCats = [];
        try {
            const [rows] = await db.inventory.query("SELECT id, name, db_shard, parent_id FROM categories ORDER BY name ASC");
            localCats = rows;
        } catch (e) {}

        const finalId = markazCodeId || Date.now().toString().slice(-6);

        res.json({
            title: toTitleCase(title) || "Markaz Product",
            description: finalDescription, // 🟢 Now uses fully compiled description
            markaz_product_code: productCode,
            markaz_code_id: finalId,
            salePrice: salePrice, 
            cutPrice: originalPrice, 
            images: images.length > 0 ? [...new Set(images)] : ["https://via.placeholder.com/400"],
            sku: `SJ10-${finalId}`, 
            categories: localCats
        });
    } catch (e) {
        console.error("💥 [Scrape] Critical Controller Error:", e);
        res.status(500).json({ message: "Network Error ya link invalid hai: " + e.message });
    }
};

// 🎯 SAVE PRODUCT 
exports.saveProduct = async (req, res) => {
    try {
        const { title, description, categoryId, shardKey, salePrice, cutPrice, sku, images, selectedSupplierId, variants, imported_region, package_information } = req.body;
        const supplierToSave = selectedSupplierId || req.supplier?.id; 

        console.log(`\n============================================`);
        console.log(`🚀 [Server 3] Save Product Started for SKU: ${sku}`);
        console.log(`============================================`);

        let cleanTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 70);
        let numericId = sku.replace(/[^0-9]/g, '') || Math.floor(100000 + Math.random() * 900000).toString();
        let finalSlug = cleanTitle, finalSku = sku; 

        if (db.sku_master) {
            try {
                const [existing] = await db.sku_master.query("SELECT id FROM sku_views WHERE sku = ? OR slug = ?", [finalSku, finalSlug]);
                if (existing && existing.length > 0) {
                    const randomSuffix = Math.floor(10 + Math.random() * 90);
                    finalSlug = `${cleanTitle}-${randomSuffix}`;
                    finalSku = `SJ10-${numericId}${randomSuffix}`;
                }
            } catch (e) {}
        }

        const limitImages = (images && images.length > 0) ? images.slice(0, 4) : [];
        const uploadPromises = limitImages.map((imgUrl, idx) => processAndUploadRemoteImage(imgUrl, finalSku, idx + 1));
        const processedImageUrls = (await Promise.all(uploadPromises)).filter(url => url !== null);

        if (processedImageUrls.length === 0) return res.status(400).json({ message: "❌ Product must have at least 1 working image." });

        const client = clients[shardKey] || clients.shard_general;
        const newId = uuidv4();

        // 1. WRITE TO TURSO SHARD
        await client.execute({
            sql: `INSERT INTO products (
                id, supplier_id, category_id, title, description, price, discounted_price, quantity,
                status, sku, slug, attributes, image_urls, video_url, created_at, package_information,
                imported_region, warranty_details, colors, sizes, season, image_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                newId, supplierToSave, categoryId, title, description, cutPrice, salePrice, 100,
                'in_stock', finalSku, finalSlug, '{}', JSON.stringify(processedImageUrls), null, new Date().toISOString(),
                package_information || "20x20x10 cm, 0.5kg", imported_region || 'Pakistan', null, '[]', '[]', 'No Season', processedImageUrls[0]
            ]
        });

        if (variants && variants.length > 0) {
            for (const v of variants) {
                await client.execute({
                    sql: `INSERT INTO variants (id, product_id, custom_color, custom_size, price, stock, is_custom, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [uuidv4(), newId, v.color, v.size, v.price, 100, 1, v.image || processedImageUrls[0]]
                }).catch(()=>{});
            }
        }

        // 🟢 2. WRITE TO CENTRAL SKU views (Using db.sku_master)
        if (db.sku_master) {
            try {
                console.log(`[Save Product] Registering in sku_views...`);
                await db.sku_master.query("INSERT INTO sku_views (id, product_id, sku, slug, views) VALUES (?, ?, ?, ?, 0)", [uuidv4(), newId, finalSku, finalSlug]);
                console.log(`✅ [Save Product] Successfully registered in sku_views!`);
            } catch (skuErr) { console.error("❌ Registry Error:", skuErr.message); }
        }

        db.suppliers.execute("UPDATE suppliers SET total_products = total_products + 1 WHERE id = ?", [supplierToSave]).catch(()=>{});

        res.json({ success: true, slug: `${finalSlug}-${finalSku}`, sku: finalSku });
    } catch (e) {
        res.status(500).json({ message: "Save Failed: " + e.message });
    }
};

// 🎯 BULK SAVE PRODUCTS
exports.bulkSaveProducts = async (req, res) => {
    try {
        const { products, categoryId, shardKey, imported_region, selectedSupplierId } = req.body;
        if (!products || !Array.isArray(products)) return res.status(400).json({ message: "Invalid array" });

        const client = clients[shardKey] || clients.shard_general;
        const supplierToSave = selectedSupplierId;
        const savedSkus = [];

        for (const prod of products) {
            const { title, description, salePrice, cutPrice, sku, images, variants, package_information } = prod;
            let cleanTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 70);
            let numericId = sku.replace(/[^0-9]/g, '') || Math.floor(100000 + Math.random() * 900000).toString();
            let finalSlug = cleanTitle, finalSku = sku; 

            if (db.sku_master) {
                try {
                    const [existing] = await db.sku_master.query("SELECT id FROM sku_views WHERE sku = ? OR slug = ?", [finalSku, finalSlug]);
                    if (existing && existing.length > 0) {
                        const randomSuffix = Math.floor(10 + Math.random() * 90);
                        finalSlug = `${cleanTitle}-${randomSuffix}`;
                        finalSku = `SJ10-${numericId}${randomSuffix}`;
                    }
                } catch (e) {}
            }

            const limitImages = (images && images.length > 0) ? images.slice(0, 4) : [];
            const uploadPromises = limitImages.map((imgUrl, idx) => processAndUploadRemoteImage(imgUrl, finalSku, idx + 1));
            const processedImageUrls = (await Promise.all(uploadPromises)).filter(url => url !== null);

            if (processedImageUrls.length === 0) continue; 

            const newId = uuidv4();
            await client.execute({
                sql: `INSERT INTO products (
                    id, supplier_id, category_id, title, description, price, discounted_price, quantity,
                    status, sku, slug, attributes, image_urls, video_url, created_at, package_information,
                    imported_region, warranty_details, colors, sizes, season, image_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    newId, supplierToSave, categoryId, title, description, cutPrice, salePrice, 100,
                    'in_stock', finalSku, finalSlug, '{}', JSON.stringify(processedImageUrls), null, new Date().toISOString(),
                    package_information || "20x20x10 cm, 0.5kg", imported_region || 'Pakistan', null, '[]', '[]', 'No Season', processedImageUrls[0]
                ]
            });

            if (variants && variants.length > 0) {
                for (const v of variants) {
                    await client.execute({
                        sql: `INSERT INTO variants (id, product_id, custom_color, custom_size, price, stock, is_custom, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        args: [uuidv4(), newId, v.color, v.size, v.price, 100, 1, v.image || processedImageUrls[0]]
                    }).catch(()=>{});
                }
            }

            // 🟢 2. WRITE TO CENTRAL SKU views (Using db.sku_master)
            if (db.sku_master) {
                await db.sku_master.query("INSERT INTO sku_views (id, product_id, sku, slug, views) VALUES (?, ?, ?, ?, 0)", [uuidv4(), newId, finalSku, finalSlug]).catch(()=>{});
            }
            db.suppliers.execute("UPDATE suppliers SET total_products = total_products + 1 WHERE id = ?", [supplierToSave]).catch(()=>{});
            savedSkus.push(finalSku);
        }

        res.json({ success: true, savedCount: savedSkus.length, skus: savedSkus });
    } catch (e) {
        res.status(500).json({ message: "Bulk Save Failed: " + e.message });
    }
};

exports.getTeam = async (req, res) => {
    try {
        const [rows] = await db.suppliers.query("SELECT id, brand_name FROM suppliers WHERE status = 'active'");
        res.json(rows);
    } catch (e) { res.status(500).json({ message: "Error" }); }
};

exports.syncAllSuppliersProductCounts = async (req, res) => {
    try {
        const [suppliers] = await db.suppliers.query("SELECT id FROM suppliers");
        for (const supplier of suppliers) {
            let totalProductsCount = 0;
            for (const shardKey in clients) {
                try {
                    const result = await clients[shardKey].execute({ sql: "SELECT COUNT(*) as count FROM products WHERE supplier_id = ?", args: [supplier.id] });
                    if (result && result.rows && result.rows[0]) totalProductsCount += parseInt(result.rows[0].count || 0);
                } catch (e) {}
            }
            await db.suppliers.execute("UPDATE suppliers SET total_products = ? WHERE id = ?", [totalProductsCount, supplier.id]);
        }
        res.json({ success: true, message: "Counters synchronized successfully!" });
    } catch (e) { res.status(500).json({ message: "Sync Failed: " + e.message }); }
};