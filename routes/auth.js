const express      = require("express");
const bcrypt       = require("bcrypt");
const { z }        = require("zod");
const rateLimit    = require("express-rate-limit");
const pool         = require("../config/db");
const { signToken, authRequired } = require("../middleware/auth");
const { sendOtpEmail }            = require("../services/emailService");
const { generateOtp, hashOtp, verifyOtp, getOtpExpiry, isOtpExpired, OTP_EXPIRY_MINUTES } = require("../utils/otp");
const { logActivity } = require("../utils/auditLog");

const router = express.Router();

// Rate limiter khusus OTP
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan OTP. Coba lagi dalam 10 menit." },
});

// Validation schema
const registerSchema = z.object({
  nama:       z.string().min(2).max(120),
  email:      z.string().email().max(150),
  password:   z.string().min(6).max(100),
  departemen: z.string().max(120).optional().default(""),
  nip:        z.string().max(50).optional().default(""),
  role:       z.enum(["Guru", "Operator/TU", "Kepala Sekolah"]).optional().default("Guru"),
});

const loginSchema = z.object({
  identifier: z.string().min(1), 
  password:   z.string().min(1),
});

const otpSchema = z.object({
  otp: z.string().length(6).regex(/^\d{6}$/, "OTP harus 6 digit angka"),
});

// POST /api/auth/register 
router.post("/register", async (req, res, next) => {
  let conn;
  try {
    const data = registerSchema.parse(req.body);
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [data.email]);
    if (existing.length) return res.status(409).json({ error: "Email sudah terdaftar" });

    const hash = await bcrypt.hash(data.password, 10);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      "SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM users FOR UPDATE"
    );
    const nextId = row.nextId;

    await conn.query(
      `INSERT INTO users (id, nama, email, password_hash, role, departemen, nip, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'menunggu_approval')`,
      [nextId, data.nama, data.email, hash, data.role, data.departemen, data.nip]
    );

    await conn.commit();

    res.status(201).json({
      message: "Pendaftaran berhasil. Menunggu approval admin.",
      userId: nextId,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);

    // Cari user berdasarkan email atau nama (case-insensitive untuk nama)
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ? OR LOWER(nama) = LOWER(?) LIMIT 1",
      [identifier, identifier]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Identitas atau password salah" });
    }

    const user = rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Identitas atau password salah" });
    }

    if (user.status === "menunggu_approval") {
      return res.status(403).json({ error: "Akun masih menunggu approval admin", status: "pending" });
    }
    if (user.status === "nonaktif") {
      return res.status(403).json({ error: "Akun dinonaktifkan" });
    }

    // 2FA active: send OTP, do not issue JWT yet
    if (user.is_2fa_enabled) {
      const otpPlain  = generateOtp();
      const otpHash   = await hashOtp(otpPlain);
      const expiresAt = getOtpExpiry();

      await pool.query(
        "UPDATE users SET otp_hash = ?, otp_expires_at = ?, otp_used = 0, otp_attempts = 0 WHERE id = ?",
        [otpHash, expiresAt, user.id]
      );

      try {
        await sendOtpEmail({ to: user.email, namaUser: user.nama, otpCode: otpPlain, expiryMin: OTP_EXPIRY_MINUTES });
      } catch (mailErr) {
        console.error("[auth:login] Gagal kirim OTP email:", mailErr.message);
        return res.status(503).json({
          success: false,
          error: mailErr.message,
        });
      }

      return res.json({
        require2FA: true,
        email:      user.email,
        message:    `Kode OTP dikirim ke ${user.email}. Berlaku ${OTP_EXPIRY_MINUTES} menit.`,
      });
    }

    // 2FA not active: issue JWT immediately
    const token = signToken(user);

    pool.query(
      "UPDATE users SET is_online = 1, last_seen_at = NOW() WHERE id = ?",
      [user.id]
    ).catch((e) => console.error("[auth:login] Gagal update status online:", e.message));

    logActivity(pool, {
      documentId: null,
      userId: user.id,
      action: "Login ke sistem",
    }).catch((e) => console.error("[auth:login] Gagal mencatat audit log:", e.message));

    res.json({
      token,
      user: _publicUser(user),
    });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", otpLimiter, async (req, res, next) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      otp:   z.string().length(6).regex(/^\d{6}$/),
    });
    const { email, otp } = schema.parse(req.body);

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });

    const user = rows[0];

    if (!user.otp_hash || !user.otp_expires_at) {
      return res.status(400).json({ error: "Tidak ada OTP aktif. Minta OTP baru." });
    }
    if (user.otp_used) {
      return res.status(400).json({ error: "OTP sudah digunakan. Minta OTP baru." });
    }
    if (isOtpExpired(user.otp_expires_at)) {
      return res.status(400).json({ error: "OTP sudah kedaluwarsa. Minta OTP baru." });
    }
    if (user.otp_attempts >= 5) {
      return res.status(429).json({ error: "Terlalu banyak percobaan. Minta OTP baru." });
    }

    const valid = await verifyOtp(otp, user.otp_hash);
    if (!valid) {
      await pool.query(
        "UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = ?",
        [user.id]
      );
      const remaining = 5 - (user.otp_attempts + 1);
      return res.status(400).json({
        error:     `OTP salah. Sisa ${Math.max(0, remaining)} percobaan.`,
        remaining: Math.max(0, remaining),
      });
    }

    // is_online diupdate lebih dulu (dibutuhkan agar status login konsisten),
    // TAPI tidak diikutkan JSON.parse/proses berat apa pun setelah ini.
    await pool.query(
      "UPDATE users SET otp_used = 1, otp_attempts = 0, is_online = 1, last_seen_at = NOW() WHERE id = ?",
      [user.id]
    );

    const token = signToken(user);

    logActivity(pool, {
      documentId: null,
      userId: user.id,
      action: "Login ke sistem (verifikasi OTP 2FA)",
    }).catch((e) => console.error("[auth:verify-otp] Gagal mencatat audit log:", e.message));

    res.json({
      token,
      user: _publicUser(user),
    });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/send-otp
router.post("/send-otp", otpLimiter, async (req, res, next) => {
  try {
    let userId, userEmail, userName;

    const header = req.headers.authorization || "";
    const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (token) {
      const jwt = require("jsonwebtoken");
      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ error: "Token tidak valid" });
      }
      userId    = payload.id;
      userEmail = payload.email;
      userName  = payload.nama;
    } else {
      const schema = z.object({ email: z.string().email() });
      const { email } = schema.parse(req.body);
      const [rows] = await pool.query("SELECT id, nama, email, status FROM users WHERE email = ? LIMIT 1", [email]);
      if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });
      if (rows[0].status !== "active") return res.status(403).json({ error: "Akun tidak aktif" });
      userId    = rows[0].id;
      userEmail = rows[0].email;
      userName  = rows[0].nama;
    }

    const otpPlain  = generateOtp();
    const otpHash   = await hashOtp(otpPlain);
    const expiresAt = getOtpExpiry();

    await pool.query(
      "UPDATE users SET otp_hash = ?, otp_expires_at = ?, otp_used = 0, otp_attempts = 0 WHERE id = ?",
      [otpHash, expiresAt, userId]
    );

    try {
      await sendOtpEmail({ to: userEmail, namaUser: userName, otpCode: otpPlain, expiryMin: OTP_EXPIRY_MINUTES });
    } catch (mailErr) {
      console.error('[SEND OTP ERROR]', mailErr);
      return res.status(503).json({
        success: false,
        error: mailErr.message,
        stack: mailErr.stack,
      });
    }

    res.json({
      message: `OTP dikirim ke ${userEmail}. Berlaku ${OTP_EXPIRY_MINUTES} menit.`,
    });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/enable-2fa
router.post("/enable-2fa", authRequired, otpLimiter, async (req, res, next) => {
  try {
    const { otp } = otpSchema.parse(req.body);

    const [rows] = await pool.query(
      "SELECT otp_hash, otp_expires_at, otp_used, otp_attempts, is_2fa_enabled FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });

    const user = rows[0];

    if (user.is_2fa_enabled) return res.status(400).json({ error: "2FA sudah aktif" });
    if (!user.otp_hash || !user.otp_expires_at) return res.status(400).json({ error: "Tidak ada OTP aktif. Minta OTP terlebih dahulu." });
    if (user.otp_used)           return res.status(400).json({ error: "OTP sudah digunakan. Minta OTP baru." });
    if (isOtpExpired(user.otp_expires_at)) return res.status(400).json({ error: "OTP sudah kedaluwarsa. Minta OTP baru." });
    if (user.otp_attempts >= 5)  return res.status(429).json({ error: "Terlalu banyak percobaan. Minta OTP baru." });

    const valid = await verifyOtp(otp, user.otp_hash);
    if (!valid) {
      await pool.query("UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = ?", [req.user.id]);
      const remaining = 5 - (user.otp_attempts + 1);
      return res.status(400).json({
        error:     `OTP salah. Sisa ${Math.max(0, remaining)} percobaan.`,
        remaining: Math.max(0, remaining),
      });
    }

    await pool.query(
      "UPDATE users SET is_2fa_enabled = 1, otp_used = 1, otp_attempts = 0 WHERE id = ?",
      [req.user.id]
    );

    res.json({ message: "2FA berhasil diaktifkan.", is2faEnabled: true });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/disable-2fa 
router.post("/disable-2fa", authRequired, async (req, res, next) => {
  try {
    const schema = z.object({ password: z.string().min(1) });
    const { password } = schema.parse(req.body);

    const [rows] = await pool.query(
      "SELECT password_hash, is_2fa_enabled FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });

    const user = rows[0];
    if (!user.is_2fa_enabled) return res.status(400).json({ error: "2FA belum aktif" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Password salah" });

    await pool.query(
      "UPDATE users SET is_2fa_enabled = 0, otp_hash = NULL, otp_expires_at = NULL, otp_used = 0, otp_attempts = 0 WHERE id = ?",
      [req.user.id]
    );

    res.json({ message: "2FA berhasil dinonaktifkan.", is2faEnabled: false });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/logout 
router.post("/logout", authRequired, async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET is_online = 0 WHERE id = ?", [req.user.id]);

    // Fire-and-forget: jangan tahan response logout hanya demi menulis audit log
    logActivity(pool, {
      documentId: null,
      userId: req.user.id,
      action: "Logout dari sistem",
    }).catch((e) => console.error("[auth:logout] Gagal mencatat audit log:", e.message));

    res.json({ message: "Logout berhasil" });
  } catch (e) {
    next(e);
  }
});

// GET /api/auth/me 
router.get("/me", authRequired, async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE users SET is_online = 1, last_seen_at = NOW() WHERE id = ?",
      [req.user.id]
    );
    const [rows] = await pool.query(
      "SELECT id, nama, email, role, departemen, nip, avatar, status, is_2fa_enabled, must_change_password, notif_email_enabled FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User tidak ditemukan" });
    const u = rows[0];
    res.json({
      user: {
        ...u,
        twoFactorEnabled:   !!u.is_2fa_enabled,
        mustChangePassword: !!u.must_change_password,
        notifEmailEnabled:  !!u.notif_email_enabled,
      },
    });
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
    await pool.query(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
      [hash, req.user.id]
    );
    res.json({ message: "Password berhasil diubah", mustChangePassword: false });
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: e.errors.map((x) => x.message).join(", ") });
    next(e);
  }
});

// POST /api/auth/refresh-session
router.post("/refresh-session", authRequired, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nama, email, role FROM users WHERE id = ? AND status = 'active'",
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: "Sesi tidak valid" });

    const token = signToken(rows[0]);
    res.json({ token });
  } catch (e) {
    next(e);
  }
});

// Helper 
function _publicUser(user) {
  return {
    id:                 user.id,
    nama:               user.nama,
    email:              user.email,
    role:               user.role,
    departemen:         user.departemen,
    nip:                user.nip,
    avatar:             user.avatar,
    status:             user.status,
    twoFactorEnabled:   !!user.is_2fa_enabled,
    mustChangePassword: !!user.must_change_password,
  };
}

module.exports = router;