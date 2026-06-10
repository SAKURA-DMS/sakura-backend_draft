const express = require("express");
const pool    = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// ── GET /api/notifications — semua notifikasi milik user ─────────────────────
router.get("/", async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const [rows] = await pool.query(
      `SELECT
         id, message, type, document_id,
         is_read, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    res.json({ notifications: rows });
  } catch (e) { next(e); }
});

// ── GET /api/notifications/unread-count — badge count saja ───────────────────
router.get("/unread-count", async (req, res, next) => {
  try {
    const [[{ cnt }]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    res.json({ unread_count: Number(cnt) });
  } catch (e) { next(e); }
});

// ── POST /api/notifications/read-all — tandai semua dibaca ───────────────────
router.post("/read-all", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    res.json({ message: "Semua notifikasi ditandai dibaca" });
  } catch (e) { next(e); }
});

// ── POST /api/notifications/:id/read — tandai satu dibaca ────────────────────
router.post("/:id/read", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "ID tidak valid" });

    const [result] = await pool.query(
      "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Notifikasi tidak ditemukan" });
    }

    res.json({ message: "Notifikasi ditandai sudah dibaca" });
  } catch (e) { next(e); }
});

// ── DELETE /api/notifications/:id — hapus satu notifikasi ────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "ID tidak valid" });

    const [result] = await pool.query(
      "DELETE FROM notifications WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Notifikasi tidak ditemukan" });
    }

    res.json({ message: "Notifikasi dihapus" });
  } catch (e) { next(e); }
});

module.exports = router;
