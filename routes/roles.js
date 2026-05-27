const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();
router.use(authRequired);

// GET /api/roles — ambil semua role + permission-nya
router.get("/", async (_req, res, next) => {
  try {
    const [perms] = await pool.query("SELECT * FROM permissions ORDER BY permission_key");
    const [rp] = await pool.query(
      `SELECT rp.role_name, p.permission_key
       FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id`
    );
    const map = {};
    for (const row of rp) {
      (map[row.role_name] ||= []).push(row.permission_key);
    }
    res.json({ permissions: perms, rolePermissions: map });
  } catch (e) { next(e); }
});

// POST /api/roles/toggle — toggle permission untuk role
router.post("/toggle", requirePermission("roles.manage"), async (req, res, next) => {
  try {
    const { role, permission } = req.body;
    if (!role || !permission) return res.status(400).json({ error: "role & permission wajib" });
    const [[p]] = await pool.query("SELECT permission_id FROM permissions WHERE permission_key = ?", [permission]);
    if (!p) return res.status(404).json({ error: "permission tidak ditemukan" });
    const [exist] = await pool.query(
      "SELECT 1 FROM role_permissions WHERE role_name = ? AND permission_id = ?",
      [role, p.permission_id]
    );
    if (exist.length) {
      await pool.query(
        "DELETE FROM role_permissions WHERE role_name = ? AND permission_id = ?",
        [role, p.permission_id]
      );
      res.json({ message: "Permission dicabut", granted: false });
    } else {
      await pool.query(
        "INSERT INTO role_permissions (role_name, permission_id) VALUES (?, ?)",
        [role, p.permission_id]
      );
      res.json({ message: "Permission diberikan", granted: true });
    }
  } catch (e) { next(e); }
});

module.exports = router;
