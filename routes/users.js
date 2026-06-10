const express  = require("express");
const bcrypt   = require("bcryptjs");
const pool     = require("../config/db");
const { authRequired }     = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();

router.use(authRequired);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users — list semua user aktif & nonaktif (admin)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requirePermission("users.view"), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nama, email, role, departemen, nip, avatar, status, created_at
       FROM users
       WHERE status != 'menunggu_approval'
       ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/pending — user yang menunggu approval
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pending", requirePermission("users.approve"), async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nama, email, role, departemen, nip, created_at
       FROM users WHERE status = 'menunggu_approval' ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users — buat user baru 
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const { nama, email, password, role, departemen, nip } = req.body;

    if (!nama?.trim())  return res.status(400).json({ error: "nama wajib diisi" });
    if (!email?.trim()) return res.status(400).json({ error: "email wajib diisi" });

    const validRoles = ["Guru", "Kepala Sekolah", "Operator/TU"];
    const userRole = validRoles.includes(role) ? role : "Guru";

    // Cek email unik
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email.trim()]);
    if (existing.length) {
      return res.status(409).json({ error: "Email sudah terdaftar" });
    }

    // Hash password — gunakan default jika tidak disediakan
    const rawPassword = password?.trim() || "Sakura@123";
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const [result] = await pool.query(
      `INSERT INTO users (nama, email, password_hash, role, departemen, nip, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [
        nama.trim(),
        email.trim().toLowerCase(),
        passwordHash,
        userRole,
        departemen?.trim() || "",
        nip?.trim() || "",
      ]
    );

    const [rows] = await pool.query(
      "SELECT id, nama, email, role, departemen, nip, avatar, status, created_at FROM users WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({ message: "User berhasil dibuat", user: rows[0] });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/:id/activate
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/users/:id/reject — tolak registrasi
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id/reject", requirePermission("users.approve"), async (req, res, next) => {
  try {
    await pool.query("DELETE FROM users WHERE id = ? AND status = 'menunggu_approval'", [req.params.id]);
    res.json({ message: "Pendaftaran ditolak" });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/users/:id — hapus user permanent 
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: "Tidak dapat menghapus akun sendiri" });
    }

    const [rows] = await pool.query("SELECT id, nama FROM users WHERE id = ?", [targetId]);
    if (!rows.length) {
      return res.status(404).json({ error: "User tidak ditemukan" });
    }

    await pool.query("DELETE FROM users WHERE id = ?", [targetId]);
    res.json({ message: `User ${rows[0].nama} berhasil dihapus` });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/users/:id/role
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/role", requirePermission("users.manageRole"), async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: "role wajib diisi" });
    await pool.query("UPDATE users SET role = ? WHERE id = ?", [role, req.params.id]);
    res.json({ message: "Role diperbarui" });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/users/:id/avatar — user hanya boleh update avatar miliknya
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/users/:id — update profil 
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const isSelf = targetId === req.user.id;

    if (!isSelf) {
      // butuh permission users.manage
      const [perm] = await pool.query(
        `SELECT 1 FROM role_permissions rp JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE rp.role_name = ? AND p.permission_key = 'users.manage'`,
        [req.user.role]
      );
      if (!perm.length) return res.status(403).json({ error: "Akses ditolak" });
    }

    const { nama, email, role, departemen, nip } = req.body;

    if (email) {
      const [existing] = await pool.query(
        "SELECT id FROM users WHERE email = ? AND id != ?",
        [email.trim().toLowerCase(), targetId]
      );
      if (existing.length) {
        return res.status(409).json({ error: "Email sudah digunakan user lain" });
      }
    }

    await pool.query(
      `UPDATE users SET
         nama       = COALESCE(?, nama),
         email      = COALESCE(?, email),
         role       = COALESCE(?, role),
         departemen = COALESCE(?, departemen),
         nip        = COALESCE(?, nip)
       WHERE id = ?`,
      [
        nama?.trim()  || null,
        email?.trim().toLowerCase() || null,
        role          || null,
        departemen?.trim() ?? null,
        nip?.trim()   ?? null,
        targetId,
      ]
    );

    const [rows] = await pool.query(
      "SELECT id, nama, email, role, departemen, nip, avatar, status, created_at FROM users WHERE id = ?",
      [targetId]
    );

    res.json({ message: "User diperbarui", user: rows[0] });
  } catch (e) { next(e); }
});

module.exports = router;
