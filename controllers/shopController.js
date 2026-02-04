// api/controllers/shopController.js

const db = require('../config/database');

exports.getFollowedShops = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Get IDs from social DB
        const [follows] = await db.social.query(
            "SELECT supplier_id FROM supplier_followers WHERE user_id = ?", 
            [userId]
        );

        if (follows.length === 0) {
            return res.status(200).json([]);
        }

        const supplierIds = follows.map(f => f.supplier_id);

        // 2. ✅ FIX: Added 'verified_status' to the query
        const [shops] = await db.suppliers.query(
            `SELECT id, brand_name, profile_pic, verified_status 
             FROM suppliers 
             WHERE id IN (?)`,
            [supplierIds]
        );

        res.status(200).json(shops);

    } catch (error) {
        console.error("GetFollowedShops Error:", error);
        res.status(500).json({ message: "Failed to fetch followed shops" });
    }
};