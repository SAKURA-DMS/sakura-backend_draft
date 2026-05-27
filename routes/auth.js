const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const pool = require("../config/db");
const { signToken, authRequired } = require("../middleware/auth");

const router = express.Router();

const registerSchema = z.object({
  nama: z.string().min(2).max(120),
  email: z.string().email().max(150),
  password: z.string().min(6).max(100),
  departemen: z.string().max(120).optional().default(""),
  nip: z.string().max(50).optional().default(""),
  role: z.enum(["Guru", "Operator/TU", "Kepala Sekolah"]).optional().default("Guru"),
});

// POST /api/auth/register — user baru dengan status menunggu_approval
router.post("/register", async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [data.email]);
    if (existing.length) return res.status(409).json({ error: "Email sudah terdaftar" });

    const hash = await bcrypt.hash(data.password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (nama, email, password_hash, role, departemen, nip, status)
       VALUES (?, ?, ?, ?, ?, ?, 'menunggu_approval')`,
      [data.nama, data.email, hash, data.role, data.departemen, data.nip]
    );
    res.status(201).json({
      message: "Pendaftaran berhasil. Menunggu approval admin.",
      userId: result.insertId,
    });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors });
    next(e);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length) return res.status(401).json({ error: "Email atau password salah" });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Email atau password salah" });

    if (user.status === "menunggu_approval") {
      return res.status(403).json({ error: "Akun masih menunggu approval admin", status: "pending" });
    }
    if (user.status === "nonaktif") {
      return res.status(403).json({ error: "Akun dinonaktifkan" });
    }

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        nama: user.nama,
        email: user.email,
        role: user.role,
        departemen: user.departemen,
        nip: user.nip,
        avatar: user.avatar,
        status: user.status,
      },
    });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors });
    next(e);
  }
});

// GET /api/auth/me — verifikasi token & ambil profil
router.get("/me", authRequired, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nama, email, role, departemen, nip, avatar, status FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });
    res.json({ user: rows[0] });
  } catch (e) {
    next(e);
  }
});

// POST /api/auth/change-password
router.post("/change-password", authRequired, async (req, res, next) => {
  try {
    const schema = z.object({
      oldPassword: z.string().min(1),
      newPassword: z.string().min(6).max(100),
    });
    const { oldPassword, newPassword } = schema.parse(req.body);
    const [rows] = await pool.query("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });
    const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: "Password lama salah" });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
    res.json({ message: "Password berhasil diubah" });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors });
    next(e);
  }
});

module.exports = router;
