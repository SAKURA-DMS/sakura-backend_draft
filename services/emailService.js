const { Resend } = require("resend");

// Railway (dan banyak platform container/PaaS lain) memblokir outbound
// traffic di port SMTP (25/465/587), jadi koneksi nodemailer -> smtp.gmail.com
// selalu gagal dengan "Connection timeout" / "ENETUNREACH" di production
// meskipun jalan normal di local. Solusinya: kirim email lewat HTTP API
// (Resend), bukan lewat socket SMTP, karena HTTPS (443) tidak diblokir Railway.
//
// Env var yang dibutuhkan di Railway:
//   RESEND_API_KEY = re_xxxxxxxx        (dari https://resend.com/api-keys)
//   RESEND_FROM    = "Sakura DMS <onboarding@resend.dev>"  (atau domain terverifikasi sendiri)
//
// PENTING: instance Resend dibuat sekali saat modul di-load (singleton),
// BUKAN dengan panggilan HTTP manual (axios) — supaya tidak ada jalur kode
// lain yang diam-diam membuka socket TCP mentah ke luar SDK resend.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * Cek konfigurasi Resend saat server start.
 * Non-fatal — hanya log warning jika API key belum di-set.
 */
async function verifySmtp() {
  if (!process.env.RESEND_API_KEY) {
    console.warn("⚠️  RESEND_API_KEY belum diset — pengiriman OTP email akan gagal");
    return;
  }
  console.log("✅ Resend email API configured");
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
  <title>SAKURA (Secure Archiving and Keeping of Unified Records for Administration)</title>
</head>
<body style="margin:0; padding:0; background:#f4f6fa; font-family:Arial, Helvetica, sans-serif; color:#2f2f35;">
  <div style="max-width:640px; margin:32px auto; background:#ffffff; border:1px solid #e7e7ef; border-radius:18px; overflow:hidden; box-shadow:0 8px 28px rgba(18, 24, 40, .08);">

    <!-- Banner -->
<div style="background:#f9e7ef;">
  <img
    src="https://sakuradms.netlify.app/sakura_branch.png"
    alt="Sakura branch"
    style="
      display:block;
      width:100%;
      height:180px;
      object-fit:cover;
      object-position:center top;
      filter:saturate(1.08) contrast(1.03);
    "
  />
</div>

<!-- Logo & Branding -->
<div
  style="
    background:#ffffff;
    padding:22px 30px;
    border-bottom:1px solid #ececf3;
    display:flex;
    justify-content:center;
    align-items:center;
    gap:16px;
  "
>

  <img
    src="https://sakuradms.netlify.app/logo_sakura.png"
    alt="Logo SAKURA"
    style="
      width:54px;
      height:54px;
      object-fit:contain;
    "
  />

  <div
    style="
      font-size:34px;
      font-weight:700;
      color:#8c3555;
      letter-spacing:1px;
      line-height:1;
    "
  >
    SAKURA
  </div>

</div>

    <!-- Body -->
    <div style="padding:34px 34px 30px;">
      <p style="margin:0 0 12px; font-size:15px; line-height:1.7;">Halo, <strong>${namaUser}</strong>,</p>
      <p style="margin:0 0 22px; font-size:14px; line-height:1.8; color:#4e4e5a;">
        Kode berikut digunakan untuk verifikasi akun SAKURA saat login atau aktivasi keamanan dua langkah.
      </p>

      <div style="max-width:360px; margin:0 auto 22px; border:1px solid #ead7df; background:#fff8fb; border-radius:14px; text-align:center; padding:20px 18px;">
        <div style="font-size:11px; color:#9a6a7a; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">Kode OTP</div>
        <div style="font-size:38px; font-weight:800; letter-spacing:10px; color:#8c3555; font-family:'Courier New', monospace; margin-bottom:6px;">${otpCode}</div>
        <div style="font-size:12px; color:#75757f;">Berlaku selama <strong>${expiryMin} menit</strong></div>
      </div>

      <div style="background:#fff8e8; border-left:4px solid #e1b23c; border-radius:8px; padding:13px 15px; font-size:13px; line-height:1.7; color:#6a5a22; margin-bottom:22px;">
        Jangan bagikan kode ini kepada siapa pun. Tim SAKURA tidak pernah meminta kode OTP Anda.
        Jika Anda tidak merasa meminta kode ini, abaikan email ini.
      </div>

      <p style="margin:0; font-size:14px; line-height:1.8; color:#4e4e5a;">
        Masukkan kode di atas pada halaman verifikasi yang sedang terbuka. Kode hanya dapat digunakan satu kali.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:16px 34px; border-top:1px solid #ececf3; background:#fbfbfd; text-align:center; font-size:12px; color:#9a9aa5;">
      © ${new Date().getFullYear()} SAKURA · Email ini dibuat otomatis, jangan dibalas.
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

  console.log("SEND OTP TO:", to);

  if (!resend) {
    throw new Error("RESEND_API_KEY belum diset di environment variables");
  }

  const { data, error } = await resend.emails.send({
    from:    process.env.RESEND_FROM || "Sakura DMS <onboarding@resend.dev>",
    to,
    subject,
    html,
    // Fallback teks polos
    text: `Kode OTP Anda: ${otpCode}\nBerlaku ${expiryMin} menit. Jangan bagikan ke siapapun.`,
  });

  if (error) {
    // Normalisasi error dari Resend SDK supaya pesannya jelas di response 503
    // yang dikembalikan auth.js, sama seperti sebelumnya.
    throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  }

  console.log("RESEND OTP SENT, id:", data?.id);
}

module.exports = { verifySmtp, sendOtpEmail };