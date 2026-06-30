const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();
router.use(authRequired);

// GET /api/audit?document_id=...
router.get("/", requirePermission("audit.view"), async (req, res, next) => {
  try {
    const { document_id, limit = 200 } = req.query;
    const where = [];
    const params = [];
    if (document_id) { where.push("a.document_id = ?"); params.push(document_id); }
    const sql = `SELECT a.*, u.nama, u.role, u.avatar, d.judul AS document_judul
                 FROM audit_trail a
                 LEFT JOIN users u ON u.id = a.user_id
                 LEFT JOIN documents d ON d.id = a.document_id
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY a.created_at DESC LIMIT ?`;
    params.push(Number(limit));
    const [rows] = await pool.query(sql, params);
    res.json({ logs: rows });
  } catch (e) { next(e); }
});

module.exports = router;