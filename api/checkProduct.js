// checkProduct.js
const db = require('./config/database');
const meiliPkg = require('meilisearch');

const MeiliSearch = meiliPkg.Meilisearch || meiliPkg.Meilisearch || meiliPkg.default || meiliPkg;

const meiliClient = new MeiliSearch({
    host: 'http://129.159.225.126:7700',
    apiKey: 'Sj10MeiliSuperKey2026'
});

// Terminal se command parameter lene ke liye (e.g. node checkProduct.js 280941)
const targetCode = process.argv[2] || "280941";

async function extractFullProductData(markazCodeOrSku) {
    console.log(`\n==================================================`);
    console.log(`🔍 SEARCHING DATABASES FOR MARKAZ CODE / SKU: "${markazCodeOrSku}"`);
    console.log(`==================================================\n`);

    try {
        const formattedSku = `SJ10-${markazCodeOrSku}`;

        // 1. ORACLE POSTGRESQL (MAIN PRODUCT DATA)
        console.log(`🗄️ [1/4] Scanning Oracle PostgreSQL (products table)...`);
        const productQuery = `
            SELECT * FROM products 
            WHERE markaz_code = $1 OR sku = $2 OR sku = $3
            LIMIT 1
        `;
        const oracleResult = await db.oracle.query(productQuery, [markazCodeOrSku, markazCodeOrSku, formattedSku]);

        if (oracleResult.rows.length === 0) {
            console.log(`❌ No product found in Oracle PostgreSQL with Markaz Code / SKU: "${markazCodeOrSku}"\n`);
            process.exit(0);
        }

        const product = oracleResult.rows[0];
        console.log(`✅ FOUND MAIN PRODUCT IN ORACLE POSTGRES:`);
        console.dir({
            id: product.id,
            title: product.title,
            sku: product.sku,
            markaz_code: product.markaz_code,
            price: product.price,
            discounted_price: product.discounted_price,
            status: product.status,
            quantity: product.quantity,
            slug: product.slug,
            supplier_id: product.supplier_id,
            category_id: product.category_id,
            created_at: product.created_at,
            image_url: product.image_url,
            images: product.image_urls ? JSON.parse(product.image_urls) : []
        }, { depth: null, colors: true });

        // 2. VARIANTS DATA
        console.log(`\n🧬 [2/4] Fetching Variants from Oracle PostgreSQL...`);
        const variantQuery = `SELECT * FROM variants WHERE product_id = $1`;
        const variantResult = await db.oracle.query(variantQuery, [product.id]);

        if (variantResult.rows.length > 0) {
            console.log(`✅ Found ${variantResult.rows.length} Connected Variants:`);
            console.dir(variantResult.rows.map(v => ({
                variant_id: v.id,
                color: v.custom_color,
                size: v.custom_size,
                price: v.price,
                stock: v.stock,
                sku: v.sku,
                image_url: v.image_url
            })), { depth: null, colors: true });
        } else {
            console.log(`⚠️ No variants found for this product.`);
        }

        // 3. SKU MASTER & VIEWS (TiDB / MySQL)
        console.log(`\n📊 [3/4] Checking SKU Master / Views DB (TiDB/MySQL)...`);
        if (db.sku_master) {
            try {
                const [skuRows] = await db.sku_master.query(
                    "SELECT * FROM sku_views WHERE product_id = ? OR sku = ?", 
                    [product.id, product.sku]
                );
                if (skuRows && skuRows.length > 0) {
                    console.log(`✅ FOUND IN SKU MASTER:`);
                    console.dir(skuRows[0], { depth: null, colors: true });
                } else {
                    console.log(`⚠️ Not found in sku_views table.`);
                }
            } catch (err) {
                console.log(`⚠️ SKU Master Query Error: ${err.message}`);
            }
        } else {
            console.log(`⚠️ db.sku_master connection not active.`);
        }

        // 4. MEILISEARCH ENGINE INDEX DATA
        console.log(`\n🏎️ [4/4] Checking Meilisearch Index...`);
        try {
            const meiliDoc = await meiliClient.index('products').getDocument(product.id);
            console.log(`✅ FOUND IN MEILISEARCH INDEX:`);
            console.dir(meiliDoc, { depth: null, colors: true });
        } catch (meiliErr) {
            console.log(`⚠️ Not indexed in Meilisearch (or index query failed).`);
        }

        console.log(`\n==================================================`);
        console.log(`🎉 Extraction Completed Successfully for: ${product.title}`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error(`💥 Extraction Error:`, error.message);
    } finally {
        process.exit(0);
    }
}

extractFullProductData(targetCode);