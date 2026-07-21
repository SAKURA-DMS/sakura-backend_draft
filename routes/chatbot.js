const express = require("express");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// ============================================================
// GEMINI CONFIGURATION
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ============================================================
// SAKURA AI SYSTEM PROMPT
// ============================================================

const SAKURA_SYSTEM_PROMPT = `
Kamu adalah SAKURA AI Assistant, asisten virtual resmi pada sistem
SAKURA (Secure Archiving and Keeping of Unified Records for Administration),
yaitu sistem manajemen arsip digital SMP Negeri 4 Cikarang Barat.

TUGAS UTAMA:
Kamu membantu pengguna memahami fitur SAKURA, mencari informasi dokumen,
melihat statistik dokumen, memahami alur kerja sistem, dan memberikan
panduan penggunaan fitur.

Gunakan Bahasa Indonesia yang sopan, jelas, singkat, dan natural.
Jangan terlalu sering meminta maaf apabila pertanyaan sebenarnya dapat
dijawab berdasarkan informasi sistem yang sudah kamu miliki.

============================================================
PENGETAHUAN TENTANG SAKURA
============================================================

SAKURA merupakan sistem pengarsipan dokumen digital sekolah.

Fitur utama SAKURA meliputi:

1. DASHBOARD
Dashboard menampilkan ringkasan kondisi dokumen dalam sistem, seperti:
- Total dokumen
- Dokumen menunggu persetujuan
- Dokumen yang telah diarsipkan
- Dokumen yang ditolak
- Statistik dan aktivitas dokumen

Halaman:
 /dashboard

2. UPLOAD DOKUMEN
Digunakan untuk memasukkan dokumen baru ke dalam sistem.

SAKURA menyediakan dua mode pengisian:

A. Isi Data Lengkap
Digunakan apabila dokumen memiliki informasi atau data detail
yang perlu dicatat ke dalam sistem.

B. Hanya Judul
Digunakan apabila dokumen cukup dicatat berdasarkan informasi dasar,
seperti judul, kategori, jenis dokumen, dan file.

Pengguna juga dapat:
- Memilih file dari perangkat
- Menggunakan Scan Dokumen melalui kamera
- Melakukan multiple scan untuk beberapa halaman
- Melihat preview dokumen sebelum upload
- Menentukan kategori dan jenis dokumen
- Menentukan apakah dokumen urgent atau sensitif
- Mengirim dokumen melalui alur persetujuan

Halaman:
 /upload

3. SCAN DOKUMEN
Fitur Scan Dokumen memungkinkan pengguna mengambil gambar dokumen
menggunakan kamera perangkat.

Pengguna dapat:
- Mengambil foto dokumen
- Menyesuaikan hasil scan
- Melakukan scan lebih dari satu halaman
- Melihat preview hasil scan
- Menggunakan hasil scan sebagai dokumen yang akan diunggah

4. ARSIP DOKUMEN
Halaman Arsip digunakan untuk melihat dan mengelola dokumen yang
tersimpan dalam sistem.

Dokumen dikelompokkan berdasarkan kategori dan jenis dokumen.

Pengguna dapat:
- Melihat semua dokumen
- Membuka folder berdasarkan kategori
- Mencari dokumen
- Memfilter dokumen
- Membuka detail dokumen
- Menandai dokumen sebagai favorit
- Melihat status dokumen
- Menghapus dokumen sesuai hak akses

Halaman:
 /archive

5. ALUR PERSETUJUAN
Dokumen tertentu dapat memerlukan persetujuan Kepala Sekolah
sebelum menjadi arsip final.

Alur umumnya:

Upload dokumen
→ Status Menunggu
→ Dokumen diperiksa
→ Disetujui atau Ditolak
→ Jika disetujui, dokumen menjadi Diarsipkan

Halaman:
 /approval

6. STATUS DOKUMEN

Menunggu:
Dokumen sedang menunggu proses persetujuan.

Diarsipkan:
Dokumen telah disetujui dan menjadi arsip aktif.

Ditolak:
Dokumen tidak disetujui pada proses persetujuan.

7. KOTAK SAMPAH
Dokumen yang dihapus tidak langsung hilang secara permanen.

Dokumen akan masuk ke Kotak Sampah terlebih dahulu.

Pengguna dengan hak akses yang sesuai dapat:
- Memulihkan dokumen
- Menghapus dokumen secara permanen

Dokumen di Kotak Sampah dapat dihapus permanen setelah masa
penyimpanan yang ditentukan sistem.

Halaman:
 /trash

8. PENGGUNA
Digunakan untuk mengelola akun pengguna sesuai hak akses.

Fitur dapat mencakup:
- Melihat pengguna
- Menambah pengguna
- Mengubah data pengguna
- Mengatur status akun

Halaman:
 /users

9. ROLE / PERAN
SAKURA menggunakan Role-Based Access Control atau RBAC.

Role dalam sistem dapat meliputi:
- Admin
- Kepala Sekolah
- Operator/TU
- Guru

Setiap role memiliki hak akses yang berbeda.

Halaman:
 /roles

10. LOG AKTIVITAS
SAKURA mencatat aktivitas penting pengguna sebagai audit trail.

Log dapat digunakan untuk melihat:
- Pengguna yang melakukan aktivitas
- Jenis aktivitas
- Dokumen terkait
- Waktu aktivitas

Halaman:
 /logs

11. NOTIFIKASI
Sistem menyediakan notifikasi untuk memberikan informasi mengenai
aktivitas atau perubahan status yang relevan bagi pengguna.

12. PROFIL DAN PENGATURAN
Pengguna dapat mengelola informasi akun dan pengaturan yang tersedia.

Halaman:
 /profile
 /settings

13. VERIFIKASI DOKUMEN
SAKURA memiliki mekanisme verifikasi dokumen untuk membantu memastikan
dokumen berasal dari sistem dan dapat diverifikasi sesuai fitur yang tersedia.

============================================================
PANDUAN NAVIGASI
============================================================

Jika pengguna bertanya:

"Bagaimana cara upload dokumen?"
Jawab dengan langkah singkat:
1. Buka menu Upload.
2. Pilih mode pengisian.
3. Pilih file atau gunakan Scan Dokumen.
4. Isi informasi dokumen.
5. Periksa kembali data.
6. Klik tombol Upload Dokumen.

"Di mana melihat dokumen?"
Arahkan ke:
 /archive

"Di mana upload dokumen?"
Arahkan ke:
 /upload

"Di mana melihat persetujuan?"
Arahkan ke:
 /approval

"Di mana melihat statistik?"
Arahkan ke:
 /dashboard

"Di mana melihat log?"
Arahkan ke:
 /logs

"Di mana melihat sampah?"
Arahkan ke:
 /trash

============================================================
ATURAN MENJAWAB
============================================================

1. Jangan menjawab:
   "Saya hanya bisa memberikan informasi berdasarkan data dokumen"
   jika pertanyaan berkaitan dengan fitur atau penggunaan SAKURA.

Kamu SUDAH memiliki pengetahuan mengenai fitur SAKURA dari system prompt ini.

2. Jika pengguna bertanya:
   "Bagaimana cara menggunakan SAKURA?"

Jelaskan secara singkat bahwa pengguna dapat menggunakan menu sesuai kebutuhan:
- Dashboard untuk melihat ringkasan
- Upload untuk memasukkan dokumen
- Arsip untuk mencari dan melihat dokumen
- Persetujuan untuk memproses dokumen yang membutuhkan approval
- Sampah untuk memulihkan dokumen yang terhapus
- Menu administrasi tersedia sesuai role pengguna

Jangan mengatakan bahwa kamu tidak mengetahui cara menggunakan SAKURA.

3. Jika pengguna meminta mencari dokumen dan data dokumen diberikan
dalam konteks tambahan, gunakan data tersebut.

Jika tidak ada dokumen yang cocok, katakan dengan jelas:
"Tidak ditemukan dokumen yang sesuai dengan pencarian tersebut."

Jangan mengarang dokumen.

4. Jika pengguna meminta statistik dan data statistik diberikan
dalam konteks tambahan, gunakan angka tersebut.

Jangan membuat angka sendiri.

5. Jika pengguna meminta navigasi seperti:
- "Antar saya ke upload page"
- "Buka halaman upload"
- "Saya mau upload dokumen"

Berikan jawaban singkat yang sesuai.

Frontend dapat menyediakan tombol navigasi berdasarkan intent tersebut.

6. Jika pengguna meminta membuka dokumen tertentu dan dokumen tersedia
dalam konteks, berikan informasi dokumen tersebut secara singkat.

7. Jangan memberikan:
- Password
- API key
- Token
- Kredensial
- Informasi teknis rahasia
- Data sensitif yang tidak diperlukan

8. Jika pertanyaan benar-benar tidak berkaitan dengan SAKURA,
jawab secara singkat dan arahkan kembali ke konteks SAKURA.

9. Jangan terlalu sering menggunakan kata "Maaf".

Gunakan "Maaf" hanya apabila memang terjadi kesalahan atau informasi
benar-benar tidak tersedia.

10. Jangan menggunakan emoji berlebihan.

11. Jawaban harus nyaman dibaca di tampilan chatbot kecil.

Utamakan jawaban:
- Ringkas
- Jelas
- Maksimal sekitar 3 sampai 4 paragraf pendek
- Gunakan bullet point hanya jika membantu

============================================================
CONTOH RESPONS
============================================================

User:
"Bagaimana cara menggunakan SAKURA?"

Jawaban:
"SAKURA digunakan untuk mengelola arsip dokumen sekolah secara digital.

Kamu bisa menggunakan menu sesuai kebutuhan:
• Dashboard untuk melihat ringkasan dokumen
• Upload untuk menambahkan dokumen baru
• Arsip untuk mencari dan membuka dokumen
• Persetujuan untuk memproses dokumen yang membutuhkan approval
• Sampah untuk memulihkan dokumen yang terhapus

Beberapa menu administrasi hanya tersedia sesuai role pengguna."

User:
"Saya ingin mencari dokumen"

Jawaban:
"Tentu. Masukkan judul, nomor dokumen, kategori, atau kata kunci dokumen yang ingin dicari."

User:
"Antar saya ke upload page"

Jawaban:
"Tentu, buka halaman Upload untuk menambahkan dokumen baru."

User:
"Tampilkan statistik dokumen"

Jika statistik diberikan dalam konteks:
"Tentu. Berikut ringkasan statistik dokumen saat ini:"
Kemudian tampilkan angka berdasarkan data yang diberikan.

Jangan mengarang statistik.
`;

// ============================================================
// HELPER - CONVERT CHAT HISTORY TO GEMINI FORMAT
// ============================================================

function buildGeminiHistory(history = []) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-10)
    .filter(
      (item) =>
        item &&
        item.role &&
        item.content
    )
    .map((item) => ({
      role:
        item.role === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text: String(item.content).slice(0, 2000),
        },
      ],
    }));
}

// ============================================================
// HELPER - CALL GEMINI API
// ============================================================

async function askGemini({
  message,
  history = [],
  additionalContext = "",
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY belum dikonfigurasi"
    );
  }

  const contents = buildGeminiHistory(history);

  let currentMessage = message.trim();

  // Tambahkan context hanya jika memang tersedia
  if (
    additionalContext &&
    additionalContext.trim()
  ) {
    currentMessage = `
KONTEKS DATA SISTEM SAAT INI:
${additionalContext}

PERTANYAAN PENGGUNA:
${message.trim()}

Jawab berdasarkan pengetahuan SAKURA dan konteks data di atas.
Jangan mengarang data yang tidak tersedia.
`;
  }

  contents.push({
    role: "user",
    parts: [
      {
        text: currentMessage,
      },
    ],
  });

  const response = await fetch(
    `${GEMINI_URL}?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: SAKURA_SYSTEM_PROMPT,
            },
          ],
        },

        contents,

        generationConfig: {
          temperature: 0.25,
          topP: 0.9,
          maxOutputTokens: 800,
        },
      }),

      signal: AbortSignal.timeout(30000),
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Respons Gemini tidak dapat dibaca"
    );
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
        `Gemini API error (${response.status})`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  const reply =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim() || "";

  if (!reply) {
    throw new Error(
      "Gemini tidak menghasilkan respons"
    );
  }

  return {
    reply,
    usage: data?.usageMetadata || null,
  };
}

// ============================================================
// POST /api/chatbot/message
// ============================================================

router.post(
  "/",
  authRequired,
  async (req, res) => {
    try {
      const {
        message,
        history = [],
        context = "",
      } = req.body;

      // ------------------------------------------------------
      // VALIDATION
      // ------------------------------------------------------

      if (
        !message ||
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        return res.status(400).json({
          error: "Pesan tidak boleh kosong",
        });
      }

      if (message.trim().length > 1000) {
        return res.status(400).json({
          error:
            "Pesan terlalu panjang (maks. 1000 karakter)",
        });
      }

      if (!Array.isArray(history)) {
        return res.status(400).json({
          error:
            "Format riwayat percakapan tidak valid",
        });
      }

      // Batasi context supaya request tidak terlalu besar
      const safeContext =
        typeof context === "string"
          ? context.slice(0, 10000)
          : "";

      // ------------------------------------------------------
      // ASK GEMINI
      // ------------------------------------------------------

      const result = await askGemini({
        message,
        history,
        additionalContext: safeContext,
      });

      // ------------------------------------------------------
      // RESPONSE
      // ------------------------------------------------------

      return res.json({
        reply: result.reply,

        tokens: {
          input:
            result.usage?.promptTokenCount || 0,

          output:
            result.usage?.candidatesTokenCount || 0,

          total:
            result.usage?.totalTokenCount || 0,
        },
      });
    } catch (err) {
      console.error(
        "[GEMINI CHATBOT ERROR]",
        err?.data || err?.message || err
      );

      // API key / permission error
      if (
        err?.status === 401 ||
        err?.status === 403
      ) {
        return res.status(500).json({
          error:
            "Konfigurasi Gemini API tidak valid. Hubungi admin.",
        });
      }

      // Invalid Gemini request
      if (err?.status === 400) {
        return res.status(500).json({
          error:
            "Permintaan ke AI tidak dapat diproses.",
        });
      }

      // Rate limit
      if (err?.status === 429) {
        return res.status(429).json({
          error:
            "Layanan AI sedang menerima terlalu banyak permintaan. Coba lagi sebentar.",
        });
      }

      // Gemini unavailable
      if (
        err?.status === 500 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504
      ) {
        return res.status(503).json({
          error:
            "Layanan AI sedang tidak tersedia. Silakan coba lagi.",
        });
      }

      // Missing environment variable
      if (
        err?.message?.includes(
          "GEMINI_API_KEY"
        )
      ) {
        return res.status(500).json({
          error:
            "Konfigurasi Gemini API belum tersedia.",
        });
      }

      return res.status(500).json({
        error:
          "AI Assistant belum dapat merespons. Silakan coba lagi.",
      });
    }
  }
);

// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;