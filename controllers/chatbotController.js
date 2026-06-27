const pool          = require("../config/db");
const { askGemini } = require("../services/geminiService");

// ── Cache sederhana TTL 3 menit ───────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 3 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.value;
}
function setCache(key, value) {
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  cache.set(key, { value, ts: Date.now() });
}

// ── System prompt (singkat untuk hemat token) ─────────────────────────────────
const BASE_SYSTEM_PROMPT = `Kamu adalah SAKURA AI, asisten manajemen dokumen sekolah.
Jawab HANYA berdasarkan DATA SISTEM di bawah. Jangan mengarang data.
Bahasa Indonesia, singkat, ramah. Gunakan poin jika lebih dari 1 item.`;

// ── Ambil konteks dari DB ──────────────────────────────────────────────────────
async function buildContext(question, user) {
  const ctx   = [];
  const lower = question.toLowerCase();
  const ownerClause = user.role === "Guru" ? "AND d.uploaded_by = ?" : "";
  const ownerParam  = user.role === "Guru" ? [user.id] : [];

  try {
    // Statistik (selalu ambil sebagai base context)
    const [stats] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(d.status='Menunggu')   AS menunggu,
              SUM(d.status='Diarsipkan') AS diarsipkan,
              SUM(d.status='Ditolak')    AS ditolak,
              SUM(d.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))  AS minggu_ini,
              SUM(d.created_at >= DATE_FORMAT(NOW(),'%Y-%m-01'))     AS bulan_ini,
              SUM(DATE(d.created_at) = CURDATE())                    AS hari_ini
       FROM documents d WHERE d.deleted_at IS NULL ${ownerClause}`,
      ownerParam
    );
    ctx.push(
      `Statistik dokumen: total=${stats[0].total}, menunggu=${stats[0].menunggu}, ` +
      `diarsipkan=${stats[0].diarsipkan}, ditolak=${stats[0].ditolak}, ` +
      `hari_ini=${stats[0].hari_ini}, minggu_ini=${stats[0].minggu_ini}, bulan_ini=${stats[0].bulan_ini}`
    );

    // Detail menunggu (jika ditanya)
    if (/(menunggu|persetujuan|pending|belum)/.test(lower)) {
      const [rows] = await pool.query(
        `SELECT d.judul, d.nomor_dokumen, u.nama, DATE(d.created_at) AS tgl
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE d.status='Menunggu' AND d.deleted_at IS NULL ${ownerClause}
         ORDER BY d.created_at DESC LIMIT 5`,
        ownerParam
      );
      ctx.push(rows.length
        ? "Dokumen menunggu:\n" + rows.map((r) => `- ${r.judul} (${r.nomor_dokumen}) oleh ${r.nama} [${r.tgl}]`).join("\n")
        : "Tidak ada dokumen menunggu.");
    }

    // Pencarian keyword
    if (/(cari|temukan|SK|surat|kurikulum)/.test(lower)) {
      const kw = question.replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
      if (kw.length) {
        const likes  = kw.map(() => "(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)").join(" OR ");
        const params = kw.flatMap((k) => [`%${k}%`, `%${k}%`]);
        const [rows] = await pool.query(
          `SELECT d.judul, d.nomor_dokumen, d.status, u.nama, DATE(d.created_at) AS tgl
           FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
           WHERE d.deleted_at IS NULL AND (${likes}) ${ownerClause}
           ORDER BY d.created_at DESC LIMIT 5`,
          [...params, ...ownerParam]
        );
        ctx.push(rows.length
          ? "Hasil cari:\n" + rows.map((r) => `- ${r.judul} | ${r.nomor_dokumen} | ${r.status} | ${r.nama} | ${r.tgl}`).join("\n")
          : "Tidak ditemukan dokumen yang cocok.");
      }
    }

    // Upload terbaru / siapa upload
    if (/(siapa|upload|mengupload|admin)/.test(lower)) {
      const [rows] = await pool.query(
        `SELECT u.nama, u.role, d.judul, DATE(d.created_at) AS tgl
         FROM documents d JOIN users u ON u.id = d.uploaded_by
         WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 5`
      );
      if (rows.length)
        ctx.push("Upload terbaru:\n" + rows.map((r) => `- ${r.nama}(${r.role}): "${r.judul}" [${r.tgl}]`).join("\n"));
    }

  } catch (e) {
    console.error("[Chatbot] buildContext error:", e.message);
  }

  return ctx.join("\n");
}

function friendlyError(err) {
  const msg = err.message || "";
  if (msg.includes("GEMINI_API_KEY"))  return "Layanan AI belum dikonfigurasi. Hubungi administrator.";
  if (msg.includes("GEMINI_403"))      return "API Key tidak memiliki izin akses Gemini.";
  if (msg.includes("GEMINI_429"))      return "AI sedang sibuk (antrian penuh). Tunggu beberapa detik lalu coba lagi.";
  if (msg.includes("Timeout"))         return "AI butuh waktu terlalu lama. Silakan coba lagi.";
  return "Terjadi kesalahan saat menghubungi AI. Silakan coba lagi.";
}

// ── POST /api/chatbot ──────────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Pesan tidak boleh kosong." });

    const trimmed  = message.trim().slice(0, 300);
    const cacheKey = `${req.user.role}:${trimmed.toLowerCase()}`;

    const cached = getCached(cacheKey);
    if (cached) return res.json({ answer: cached, fromCache: true });

    const context      = await buildContext(trimmed, req.user);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nDATA SISTEM:\n${context}`;
    const answer       = await askGemini(systemPrompt, trimmed);

    setCache(cacheKey, answer);
    res.json({ answer });
  } catch (e) {
    console.error("[Chatbot] error:", e.message);
    res.status(502).json({ error: friendlyError(e) });
  }
}

module.exports = { handleChat };