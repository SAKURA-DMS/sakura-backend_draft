const nodemailer = require("nodemailer");

// ── Buat transporter sekali saja (singleton) ──────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: process.env.NODE_ENV === "production",
  },
});

/**
 * Verifikasi koneksi SMTP saat server start.
 * Non-fatal — hanya log warning jika gagal.
 */
async function verifySmtp() {
  try {
    await transporter.verify();
    console.log("✅ SMTP connection verified");
  } catch (err) {
    console.warn("⚠️  SMTP connection failed:", err.message);
  }
}

/**
 * Template HTML email OTP.
 *
 * @param {string} namaUser  - Nama user penerima
 * @param {string} otpCode   - 6-digit OTP plaintext (hanya untuk email, tidak disimpan ke DB)
 * @param {number} expiryMin - Masa berlaku dalam menit
 * @returns {string} HTML string
 */
function buildOtpEmailHtml(namaUser, otpCode, expiryMin = 5) {
  return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kode OTP Sakura DMS</title>
  <style>
    body { margin:0; padding:0; background:#f5f5f7; font-family:'Helvetica Neue',Arial,sans-serif; }
    .wrapper { max-width:520px; margin:40px auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
    .header { background:linear-gradient(135deg,#e75480 0%,#f4a0b5 100%); padding:32px 24px; text-align:center; }
    .header h1 { margin:0; color:#fff; font-size:22px; font-weight:700; letter-spacing:.5px; }
    .header p  { margin:4px 0 0; color:rgba(255,255,255,.85); font-size:13px; }
    .body { padding:32px 28px; }
    .greeting { font-size:15px; color:#333; margin-bottom:12px; }
    .desc { font-size:14px; color:#555; margin-bottom:24px; line-height:1.6; }
    .otp-box { background:#fdf2f5; border:2px dashed #e75480; border-radius:12px; padding:20px; text-align:center; margin-bottom:24px; }
    .otp-label { font-size:12px; color:#999; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
    .otp-code { font-size:38px; font-weight:800; letter-spacing:10px; color:#e75480; font-family:'Courier New',monospace; }
    .expiry { font-size:13px; color:#888; margin-top:8px; }
    .warning { background:#fff8e1; border-left:4px solid #ffc107; border-radius:4px; padding:12px 16px; font-size:13px; color:#7a6200; margin-bottom:24px; }
    .footer { background:#f5f5f7; padding:20px 28px; text-align:center; font-size:12px; color:#aaa; border-top:1px solid #eee; }
    .sakura { font-size:18px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="sakura">🌸</div>
      <h1>Sakura DMS</h1>
      <p>Sistem Manajemen Dokumen Sekolah</p>
    </div>
    <div class="body">
      <p class="greeting">Halo, <strong>${namaUser}</strong> 👋</p>
      <p class="desc">
        Anda meminta kode verifikasi untuk mengaktifkan atau masuk menggunakan
        <strong>Two-Factor Authentication (2FA)</strong> pada akun Sakura DMS Anda.
      </p>

      <div class="otp-box">
        <div class="otp-label">Kode OTP Anda</div>
        <div class="otp-code">${otpCode}</div>
        <div class="expiry">⏱ Berlaku selama <strong>${expiryMin} menit</strong></div>
      </div>

      <div class="warning">
        ⚠️ <strong>Jangan bagikan kode ini</strong> kepada siapapun.
        Tim Sakura DMS tidak pernah meminta kode OTP Anda.
        Jika Anda tidak meminta kode ini, abaikan email ini.
      </div>

      <p class="desc">
        Masukkan kode di atas pada halaman verifikasi yang sedang terbuka.
        Kode hanya dapat digunakan <strong>satu kali</strong>.
      </p>
    </div>
    <div class="footer">
      © ${new Date().getFullYear()} Sakura DMS &nbsp;·&nbsp; Email ini dibuat otomatis, jangan dibalas.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Kirim email OTP ke user.
 *
 * @param {object} params
 * @param {string} params.to        - Alamat email tujuan
 * @param {string} params.namaUser  - Nama user (untuk greeting)
 * @param {string} params.otpCode   - 6-digit OTP plaintext
 * @param {number} [params.expiryMin=5] - Masa berlaku (menit)
 * @returns {Promise<void>}
 */
async function sendOtpEmail({ to, namaUser, otpCode, expiryMin = 5 }) {
  const subject = `[Sakura DMS] Kode OTP Verifikasi: ${otpCode}`;
  const html    = buildOtpEmailHtml(namaUser, otpCode, expiryMin);

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || `"Sakura DMS" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    // Fallback teks polos
    text: `Kode OTP Anda: ${otpCode}\nBerlaku ${expiryMin} menit. Jangan bagikan ke siapapun.`,
  });
}

module.exports = { verifySmtp, sendOtpEmail };