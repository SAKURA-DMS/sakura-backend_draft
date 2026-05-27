const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

router.get("/", async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
      [req.user.id]
    );
    res.json({ notifications: rows });
  } catch (e) { next(e); }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    res.json({ message: "Ditandai sudah dibaca" });
  } catch (e) { next(e); }
});

router.post("/read-all", async (req, res, next) => {
  try {
    await pool.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.user.id]);
    res.json({ message: "Semua notifikasi ditandai dibaca" });
  } catch (e) { next(e); }
});

module.exports = router;
