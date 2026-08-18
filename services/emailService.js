const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function verifySmtp() {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY belum diset — pengiriman OTP email akan gagal"
    );
    return;
  }

  console.log("Resend email API configured");
}

/**
 * Template HTML email OTP.
 *
 * @param {string} namaUser  
 * @param {string} otpCode  
 * @param {number} expiryMin 
 * @returns {string} 
 */
function buildOtpEmailHtml(namaUser, otpCode, expiryMin = 5) {
  return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SAKURA - Kode OTP Verifikasi</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f4f6fa;
    font-family:Arial, Helvetica, sans-serif;
    color:#2f2f35;
  "
>

  <div
    style="
      max-width:640px;
      margin:32px auto;
      background:#ffffff;
      border:1px solid #e7e7ef;
      border-radius:18px;
      overflow:hidden;
      box-shadow:0 8px 28px rgba(18,24,40,.08);
    "
  >

    <!-- Sakura Banner -->
    <div
      style="
        background:#f9e7ef;
        line-height:0;
      "
    >
      <img
        src="https://sakuradms.com/sakura_branch.png"
        alt="Sakura"
        style="
          display:block;
          width:100%;
          height:180px;
          object-fit:cover;
          object-position:center top;
          border:0;
        "
      />
    </div>

    <!-- Logo & Branding -->
    <div
      style="
        background:#ffffff;
        padding:24px 34px;
        border-bottom:1px solid #ececf3;
      "
    >
      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        border="0"
        style="
          border-collapse:collapse;
          margin:0 auto;
        "
      >
        <tr>

          <!-- Logo -->
          <td
            style="
              vertical-align:middle;
              padding:0 16px 0 0;
            "
          >
            <img
              src="https://sakuradms.com/logo_sakura.png"
              alt="Logo SAKURA"
              width="62"
              height="62"
              style="
                display:block;
                width:62px;
                height:62px;
                object-fit:contain;
                border:0;
              "
            />
          </td>

          <!-- Brand Text -->
          <td
            style="
              vertical-align:middle;
              padding:0;
            "
          >
            <div
              style="
                margin:0 0 5px 0;
                font-size:32px;
                font-weight:700;
                color:#8c3555;
                letter-spacing:1.5px;
                line-height:1.05;
              "
            >
              SAKURA
            </div>

            <div
              style="
                margin:0;
                max-width:390px;
                font-size:11px;
                font-weight:500;
                color:#77727a;
                line-height:1.45;
                letter-spacing:.15px;
              "
            >
              Secure Archiving and Keeping of Unified Records for Administration
            </div>
          </td>

        </tr>
      </table>
    </div>

    <!-- Email Body -->
    <div
      style="
        padding:34px 38px 30px;
      "
    >

      <p
        style="
          margin:0 0 12px;
          font-size:15px;
          line-height:1.7;
          color:#2f2f35;
        "
      >
        Halo, <strong>${namaUser}</strong>,
      </p>

      <p
        style="
          margin:0 0 24px;
          font-size:14px;
          line-height:1.8;
          color:#4e4e5a;
        "
      >
        Kode berikut digunakan untuk verifikasi akun SAKURA saat login
        atau aktivasi keamanan dua langkah.
      </p>

      <!-- OTP Card -->
      <div
        style="
          max-width:360px;
          margin:0 auto 24px;
          border:1px solid #ead7df;
          background:#fff8fb;
          border-radius:14px;
          text-align:center;
          padding:22px 18px;
        "
      >

        <div
          style="
            font-size:11px;
            color:#9a6a7a;
            text-transform:uppercase;
            letter-spacing:1.2px;
            margin-bottom:12px;
            font-weight:600;
          "
        >
          Kode OTP
        </div>

        <div
          style="
            font-size:38px;
            font-weight:800;
            letter-spacing:10px;
            color:#8c3555;
            font-family:'Courier New', monospace;
            margin:0 0 8px;
            padding-left:10px;
          "
        >
          ${otpCode}
        </div>

        <div
          style="
            font-size:12px;
            color:#75757f;
          "
        >
          Berlaku selama <strong>${expiryMin} menit</strong>
        </div>

      </div>

      <!-- Security Warning -->
      <div
        style="
          background:#fff8e8;
          border-left:4px solid #e1b23c;
          border-radius:8px;
          padding:14px 16px;
          font-size:13px;
          line-height:1.7;
          color:#6a5a22;
          margin-bottom:22px;
        "
      >
        <strong>Jangan bagikan kode ini kepada siapa pun.</strong>
        Tim SAKURA tidak pernah meminta kode OTP Anda.
        Jika Anda tidak merasa meminta kode ini, abaikan email ini.
      </div>

      <p
        style="
          margin:0;
          font-size:14px;
          line-height:1.8;
          color:#4e4e5a;
        "
      >
        Masukkan kode di atas pada halaman verifikasi yang sedang terbuka.
        Kode hanya dapat digunakan satu kali.
      </p>

    </div>

    <!-- Footer -->
    <div
      style="
        padding:18px 30px;
        border-top:1px solid #ececf3;
        background:#fbfbfd;
        text-align:center;
      "
    >

      <div
        style="
          margin:0 0 5px;
          font-size:12px;
          font-weight:600;
          color:#77727f;
        "
      >
        SAKURA Document Management System
      </div>

      <div
        style="
          margin:0;
          font-size:11px;
          line-height:1.6;
          color:#9a9aa5;
        "
      >
        © ${new Date().getFullYear()} SAKURA ·
        Email ini dibuat otomatis, mohon tidak membalas email ini.
      </div>

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
 * @param {string} params.to
 * @param {string} params.namaUser
 * @param {string} params.otpCode
 * @param {number} [params.expiryMin=5]
 * @returns {Promise<void>}
 */
async function sendOtpEmail({
  to,
  namaUser,
  otpCode,
  expiryMin = 5,
}) {
  const subject = `[SAKURA DMS] Kode OTP Verifikasi`;

  const html = buildOtpEmailHtml(
    namaUser,
    otpCode,
    expiryMin
  );

  console.log("SEND OTP TO:", to);

  if (!resend) {
    throw new Error(
      "RESEND_API_KEY belum diset di environment variables"
    );
  }

  const { data, error } = await resend.emails.send({
    from:
      process.env.RESEND_FROM ||
      "SAKURA DMS <onboarding@resend.dev>",

    to,

    subject,

    html,

    text:
      `Halo, ${namaUser}.\n\n` +
      `Kode OTP verifikasi SAKURA Anda: ${otpCode}\n` +
      `Kode berlaku selama ${expiryMin} menit dan hanya dapat digunakan satu kali.\n\n` +
      `Jangan bagikan kode ini kepada siapa pun.`,
  });

  if (error) {
    throw new Error(
      `Resend API error: ${
        error.message || JSON.stringify(error)
      }`
    );
  }

  console.log(
    "RESEND OTP SENT, id:",
    data?.id
  );
}

module.exports = {
  verifySmtp,
  sendOtpEmail,
};