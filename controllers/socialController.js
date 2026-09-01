// controllers/socialController.js (Cart & Social Backend)
const db = require('../config/database');
const redis = require('../config/redis'); // Central Redis for instant cache invalidation
const axios = require('axios');

const ORDERS_BACKEND_URL = (process.env.ORDERS_BACKEND_URL || 'https://orders.sj10.pk').replace(/\/$/, '');
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || 'Sj10_Internal_AounAbbas_!@2025_#_TopSecret').replace(/['"]/g, '').trim();

// 🟢 HELPER: Safe Internal Notification Dispatcher to Order Backend
const sendSocialNotification = async (payload) => {
    try {
        await axios.post(`${ORDERS_BACKEND_URL}/api/internal/notify/broadcast`, {
            userIds: [payload.recipientId],
            title: payload.title,
            body: payload.body,
            url: payload.url || '/profile/followed-shops',
            imageUrl: payload.image || null
        }, {
            headers: { 
                'x-internal-api-key': INTERNAL_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
        console.log(`✅ [Social Push] Triggered notification for ${payload.recipientType}: ${payload.recipientId}`);
    } catch (err) {
        console.warn(`⚠️ [Social Push Warning] Could not notify ${payload.recipientId}:`, err.response?.data?.message || err.message);
    }
};

// ==============================================================
// 1. GET FOLLOW STATUS
// ==============================================================
exports.getFollowStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        const [rows] = await db.social.query(
            "SELECT 1 FROM supplier_followers WHERE user_id = ? AND supplier_id = ? LIMIT 1",
            [userId, supplierId]
        );

        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json({ isFollowing: rows.length > 0 });
    } catch (error) {
        console.error("🔴 Get Follow Status Error:", error.message);
        res.status(500).json({ error: "Server Error" });
    }
};

// ==============================================================
// 2. TOGGLE FOLLOW (WITH REDIS PURGE & DUAL PUSH NOTIFICATIONS)
// ==============================================================
exports.toggleFollow = async (req, res) => {
    let socialConnection, suppliersConnection;

    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        console.log(`🟡 [Social] User: ${userId} toggling follow for Supplier: ${supplierId}`);

        socialConnection = await db.social.getConnection();
        suppliersConnection = await db.suppliers.getConnection();

        await socialConnection.beginTransaction();
        await suppliersConnection.beginTransaction();

        const [existing] = await socialConnection.query(
            "SELECT id FROM supplier_followers WHERE user_id = ? AND supplier_id = ? LIMIT 1", 
            [userId, supplierId]
        );

        let isFollowing = false;

        if (existing.length > 0) {
            // 🚨 UNFOLLOW (Delete from DB & Decrease Count)
            await socialConnection.execute(
                "DELETE FROM supplier_followers WHERE user_id = ? AND supplier_id = ?", 
                [userId, supplierId]
            );
            await suppliersConnection.execute(
                "UPDATE suppliers SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = ?", 
                [supplierId]
            );
            isFollowing = false;
        } else {
            // 🚨 FOLLOW (Insert into DB & Increase Count)
            await socialConnection.execute(
                "INSERT INTO supplier_followers (user_id, supplier_id, created_at) VALUES (?, ?, NOW())", 
                [userId, supplierId]
            );
            await suppliersConnection.execute(
                "UPDATE suppliers SET followers_count = followers_count + 1 WHERE id = ?", 
                [supplierId]
            );
            isFollowing = true;
        }

        await socialConnection.commit();
        await suppliersConnection.commit();

        // 🟢 3. REAL-TIME REDIS CACHE INVALIDATION
        // Supplier ka followers cache delete karein taake supplier panel foran update ho!
        try {
            if (redis) {
                await redis.del(`supplier_followers_v3_${supplierId}`);
                console.log(`⚡ [REDIS PURGED] Cleared followers cache for Supplier: ${supplierId}`);
            }
        } catch (rErr) {}

        // 🟢 4. SEND REAL-TIME NOTIFICATIONS (Only when following)
        if (isFollowing) {
            // Fetch User & Supplier Profile Info
            const [userRows] = await db.users.query("SELECT full_name, profile_pic FROM users WHERE id = ?", [userId]);
            const [supRows] = await db.suppliers.query("SELECT brand_name, full_name, profile_pic FROM suppliers WHERE id = ?", [supplierId]);

            const user = userRows[0] || { full_name: "A Customer", profile_pic: null };
            const supplier = supRows[0] || { brand_name: "SJ10 Store", profile_pic: null };

            const userDp = user.profile_pic || "https://www.sj10.pk/default-avatar.png";
            const storeLogo = supplier.profile_pic || "https://www.sj10.pk/default-store.png";
            const storeName = supplier.brand_name || supplier.full_name || "SJ10 Store";

            // A. Send Push Alert to SUPPLIER (With User DP & Name)
            sendSocialNotification({
                recipientId: supplierId,
                recipientType: 'supplier',
                title: "🎉 Naya Follower Mila!",
                body: `${user.full_name} ne aapke store ko follow kiya hai.`,
                image: userDp,
                url: "/profile/followed-shops"
            });

            // B. Send Push Alert to CUSTOMER (With Store Logo & Name)
            sendSocialNotification({
                recipientId: userId,
                recipientType: 'user',
                title: "🏪 Store Follow Ho Gaya!",
                body: `Aapne "${storeName}" ko follow kar liya hai. Inki nayi products ke updates milte rahenge!`,
                image: storeLogo,
                url: "/profile/followed-shops"
            });
        }

        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json({ 
            success: true,
            message: isFollowing ? "Followed successfully." : "Unfollowed.", 
            isFollowing 
        });

    } catch (error) {
        if (socialConnection) await socialConnection.rollback();
        if (suppliersConnection) await suppliersConnection.rollback();
        
        console.error("🔴 Toggle Follow Error:", error.message);
        res.status(500).json({ error: "Server Error" });
    } finally {
        if (socialConnection) socialConnection.release();
        if (suppliersConnection) suppliersConnection.release();
    }
};