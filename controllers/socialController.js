const db = require('../config/database');

// 🚫 DO NOT CACHE (Personal User Action)
exports.getFollowStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        console.log(`🟡 [TiDB MySQL] Checking Follow Status. User: ${userId} -> Supplier: ${supplierId}`);

        const [rows] = await db.social.query(
            "SELECT 1 FROM supplier_followers WHERE user_id = ? AND supplier_id = ? LIMIT 1",
            [userId, supplierId]
        );

        // Security check for private routes
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json({ isFollowing: rows.length > 0 });
    } catch (error) {
        console.error("🔴 Get Follow Status Error:", error.message);
        res.status(500).json({ error: "Server Error" });
    }
};

// 🚫 DO NOT CACHE (Write Operation)
exports.toggleFollow = async (req, res) => {
    let socialConnection, suppliersConnection;

    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        console.log(`🟡 [TiDB MySQL] Toggling Follow Status. User: ${userId} -> Supplier: ${supplierId}`);

        // Get dedicated connections for transactional safety
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
            // 🚨 UNFOLLOW (Delete from Social & Decrease Count)
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
            // 🚨 FOLLOW (Insert into Social & Increase Count)
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

        // Commit both transactions safely
        await socialConnection.commit();
        await suppliersConnection.commit();

        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.status(200).json({ 
            message: isFollowing ? "Followed" : "Unfollowed", 
            isFollowing 
        });

    } catch (error) {
        // Rollback on any failure to prevent mismatched count
        if (socialConnection) await socialConnection.rollback();
        if (suppliersConnection) await suppliersConnection.rollback();
        
        console.error("🔴 Toggle Follow Error:", error.message);
        res.status(500).json({ error: "Server Error" });
    } finally {
        // Release connections back to the pools
        if (socialConnection) socialConnection.release();
        if (suppliersConnection) suppliersConnection.release();
    }
};