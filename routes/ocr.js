/**
 * routes/ocr.js
 *
 * Endpoint OCR untuk fitur "Isi Data Lengkap" pada form upload.
 * Menggantikan OCR lama (Tesseract.js di frontend, heuristic regex parser)
 * dengan Gemini Vision API yang membaca gambar dokumen langsung di backend.
 *
 * Flow:
 *   1. Frontend mengirim gambar hasil scan (multipart/form-data, field "image").
 *   2. Backend memanggil Gemini Vision (services/geminiService.js) untuk
 *      menentukan jenis dokumen dan mengekstrak metadata-nya.
 *   3. Backend memvalidasi jenis dokumen terhadap daftar yang didukung
 *      (ijazah, skl, sertifikat, transkrip). Selain itu dianggap "unsupported".
 */

const express = require("express");
const { authRequired } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { analyzeDocumentImage } = require("../services/geminiService");

const router = express.Router();
router.use(authRequired);

const SUPPORTED_DOCUMENT_TYPES = new Set(["ijazah", "skl", "sertifikat", "transkrip"]);

// POST /api/ocr/scan
router.post("/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Gambar dokumen wajib diunggah untuk OCR." });
    }
    if (!req.file.mimetype || !req.file.mimetype.startsWith("image/")) {
      return res.status(415).json({ error: "OCR hanya menerima file gambar (JPG/PNG/WEBP)." });
    }

    const base64Image = req.file.buffer.toString("base64");
    const result = await analyzeDocumentImage(base64Image, req.file.mimetype);

    if (!result || typeof result !== "object" || !result.document_type) {
      return res.status(502).json({
        document_type: "unsupported",
        message: "Gagal membaca respons OCR. Coba scan ulang dengan pencahayaan yang lebih baik.",
      });
    }

    if (!SUPPORTED_DOCUMENT_TYPES.has(result.document_type)) {
      return res.json({
        document_type: "unsupported",
        message: "Dokumen tidak didukung OCR",
      });
    }

    return res.json({
      document_type: result.document_type,
      confidence: typeof result.confidence === "number" ? result.confidence : null,
      fields: result.fields && typeof result.fields === "object" ? result.fields : {},
    });
  } catch (err) {
    console.error("[OCR] /scan gagal:", err);
    const msg = err?.message || "";

    if (msg === "GEMINI_429") {
      return res.status(429).json({ error: "Layanan OCR sedang sibuk (rate limit). Coba lagi dalam beberapa saat." });
    }
    if (msg === "GEMINI_403") {
      return res.status(403).json({ error: "Akses ke Gemini API ditolak. Periksa GEMINI_API_KEY." });
    }
    if (msg === "GEMINI_TIMEOUT") {
      return res.status(408).json({ error: "Proses OCR memakan waktu terlalu lama. Coba lagi." });
    }
    if (msg.includes("GEMINI_API_KEY")) {
      return res.status(503).json({ error: "Layanan OCR belum dikonfigurasi. Hubungi administrator." });
    }

    return res.status(500).json({ error: "Gagal memproses OCR. Coba scan ulang dokumen." });
  }
});

module.exports = router;
