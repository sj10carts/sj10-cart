// cart-backend/api/controllers/socialController.js
const db = require('../config/database');

exports.getFollowStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        const [rows] = await db.social.query(
            "SELECT 1 FROM supplier_followers WHERE user_id = ? AND supplier_id = ?",
            [userId, supplierId]
        );

        res.status(200).json({ isFollowing: rows.length > 0 });
    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
};

exports.toggleFollow = async (req, res) => {
    try {
        const userId = req.user.id;
        const supplierId = req.params.id;

        const [existing] = await db.social.query(
            "SELECT 1 FROM supplier_followers WHERE user_id = ? AND supplier_id = ?",
            [userId, supplierId]
        );

        if (existing.length > 0) {
            // Unfollow
            await db.social.execute("DELETE FROM supplier_followers WHERE user_id = ? AND supplier_id = ?", [userId, supplierId]);
            await db.suppliers.execute("UPDATE suppliers SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = ?", [supplierId]);
            res.status(200).json({ message: "Unfollowed", isFollowing: false });
        } else {
            // Follow
            await db.social.execute("INSERT INTO supplier_followers (user_id, supplier_id) VALUES (?, ?)", [userId, supplierId]);
            await db.suppliers.execute("UPDATE suppliers SET followers_count = followers_count + 1 WHERE id = ?", [supplierId]);
            res.status(200).json({ message: "Followed", isFollowing: true });
        }
    } catch (error) {
        console.error("Toggle Follow Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};