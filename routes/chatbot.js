const express = require("express");
const router  = express.Router();
const Anthropic = require("@anthropic-ai/sdk");
const { authRequired } = require("../middleware/auth");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── System prompt SAKURA AI Assistant ────────────────────────────────────────
const SAKURA_SYSTEM_PROMPT = `Kamu adalah SAKURA Assistant 🌸, asisten AI resmi untuk sistem SAKURA (Secure Archiving and Keeping of Unified Records for Administration) — sistem manajemen arsip digital SMP Negeri 4 Cikarang Barat.

IDENTITAS:
- Nama: SAKURA Assistant
- Tujuan: Membantu pengguna memahami dan menggunakan sistem SAKURA
- Bahasa: Indonesia yang sopan, ramah, dan profesional

FITUR SISTEM SAKURA yang perlu kamu ketahui:
1. **Upload Dokumen** — Pengguna dapat mengunggah file PDF, Word, dll. ke sistem
2. **Arsip Digital** — Semua dokumen tersimpan terstruktur berdasarkan kategori & folder
3. **Alur Persetujuan** — Dokumen harus melewati persetujuan sebelum diarsipkan:
   - Guru mengupload → status "Menunggu"
   - Operator/TU atau Kepala Sekolah mereview → "Disetujui" atau "Ditolak"
   - Setelah disetujui → status "Diarsipkan"
4. **Manajemen Pengguna** — Admin dapat menambah/mengedit/menonaktifkan akun
5. **Manajemen Peran** — Peran: Admin, Kepala Sekolah, Operator/TU, Guru
6. **Log Aktivitas** — Setiap aksi tercatat untuk audit trail
7. **Notifikasi** — Pemberitahuan otomatis saat status dokumen berubah
8. **Profil & Pengaturan** — Edit profil, ganti password, preferensi tampilan
9. **Verifikasi Dokumen** — Dokumen dapat diverifikasi keasliannya via QR/link

PANDUAN NAVIGASI:
- Dashboard (/dashboard): Ringkasan statistik dokumen & grafik aktivitas
- Beranda (/home): Informasi sistem & tim pengembang  
- Upload (/upload): Form upload dokumen baru
- Arsip (/archive): Lihat semua dokumen yang telah diarsipkan
- Persetujuan (/approval): Dokumen menunggu persetujuan (untuk Operator & Kepsek)
- Pengguna (/users): Manajemen akun pengguna (Admin only)
- Peran (/roles): Manajemen hak akses (Admin only)
- Log (/logs): Riwayat aktivitas sistem (Admin only)
- Pengaturan (/settings): Konfigurasi sistem
- Profil (/profile): Edit profil pengguna

HATI-HATI:
- Jangan memberikan informasi teknis sensitif (kode program, kredensial, dll.)
- Jika pertanyaan di luar konteks SAKURA, tetap bantu secara umum namun arahkan kembali ke sistem
- Untuk masalah teknis serius, arahkan ke Admin sistem

FORMAT RESPONS:
- Gunakan format yang bersih dan mudah dibaca
- Boleh gunakan bullet point jika perlu
- Sertakan emoji sakura 🌸 sesekali untuk keramahan
- Maksimal 3-4 paragraf kecuali penjelasan teknis memerlukan lebih
`;

// ── POST /api/chatbot/message ─────────────────────────────────────────────────
router.post("/message", authRequired, async (req, res) => {
  const { message, history = [] } = req.body;

  // Validasi input
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Pesan tidak boleh kosong" });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: "Pesan terlalu panjang (maks. 1000 karakter)" });
  }
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: "Format riwayat tidak valid" });
  }

  // Batasi history ke 10 pesan terakhir untuk efisiensi
  const recentHistory = history
    .slice(-10)
    .filter(msg => msg.role && msg.content)
    .map(msg => ({
      role: msg.role === "user" ? "user" : "assistant",
      content: String(msg.content).slice(0, 2000),
    }));

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SAKURA_SYSTEM_PROMPT,
      messages: [
        ...recentHistory,
        { role: "user", content: message.trim() },
      ],
    });

    const reply = response.content[0]?.text ?? "Maaf, saya tidak dapat memproses permintaan Anda saat ini.";

    res.json({
      reply,
      tokens: {
        input:  response.usage?.input_tokens  ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    });
  } catch (err) {
    console.error("[CHATBOT ERROR]", err?.message ?? err);

    if (err?.status === 401 || err?.error?.type === "authentication_error") {
      return res.status(500).json({ error: "Konfigurasi AI tidak valid. Hubungi admin." });
    }
    if (err?.status === 429) {
      return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
    }

    res.status(500).json({ error: "Gagal menghubungi AI. Silakan coba lagi nanti." });
  }
});

module.exports = router;
