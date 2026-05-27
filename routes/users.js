const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();

router.use(authRequired);

// GET /api/users — list semua user (admin)
router.get("/", requirePermission("users.view"), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nama, email, role, departemen, nip, avatar, status, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) { next(e); }
});

// GET /api/users/pending — user yang menunggu approval
router.get("/pending", requirePermission("users.approve"), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nama, email, role, departemen, nip, created_at
       FROM users WHERE status = 'menunggu_approval' ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) { next(e); }
});

// POST /api/users/:id/activate
router.post("/:id/activate", requirePermission("users.approve"), async (req, res, next) => {
  try {
    const { role } = req.body || {};
    await pool.query(
      "UPDATE users SET status = 'active', role = COALESCE(?, role) WHERE id = ?",
      [role || null, req.params.id]
    );
    res.json({ message: "User diaktifkan" });
  } catch (e) { next(e); }
});

// DELETE /api/users/:id/reject — tolak registrasi
router.delete("/:id/reject", requirePermission("users.approve"), async (req, res, next) => {
  try {
    await pool.query("DELETE FROM users WHERE id = ? AND status = 'menunggu_approval'", [req.params.id]);
    res.json({ message: "Pendaftaran ditolak" });
  } catch (e) { next(e); }
});

// PATCH /api/users/:id/role
router.patch("/:id/role", requirePermission("users.manageRole"), async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: "role wajib diisi" });
    await pool.query("UPDATE users SET role = ? WHERE id = ?", [role, req.params.id]);
    res.json({ message: "Role diperbarui" });
  } catch (e) { next(e); }
});

// PATCH /api/users/:id/avatar — user hanya boleh update avatar miliknya
router.patch("/:id/avatar", async (req, res, next) => {
  try {
    if (Number(req.params.id) !== req.user.id) {
      return res.status(403).json({ error: "Hanya bisa mengubah avatar sendiri" });
    }
    const { avatar } = req.body;
    await pool.query("UPDATE users SET avatar = ? WHERE id = ?", [avatar || null, req.user.id]);
    res.json({ message: "Avatar diperbarui" });
  } catch (e) { next(e); }
});

// PATCH /api/users/:id — update profil
router.patch("/:id", async (req, res, next) => {
  try {
    const isSelf = Number(req.params.id) === req.user.id;
    if (!isSelf) {
      // butuh permission users.manage
      const [perm] = await pool.query(
        `SELECT 1 FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE rp.role_name = ? AND p.permission_key = 'users.manage'`,
        [req.user.role]
      );
      if (!perm.length) return res.status(403).json({ error: "Akses ditolak" });
    }
    const { nama, departemen, nip } = req.body;
    await pool.query(
      "UPDATE users SET nama = COALESCE(?, nama), departemen = COALESCE(?, departemen), nip = COALESCE(?, nip) WHERE id = ?",
      [nama || null, departemen || null, nip || null, req.params.id]
    );
    res.json({ message: "Profil diperbarui" });
  } catch (e) { next(e); }
});

module.exports = router;
