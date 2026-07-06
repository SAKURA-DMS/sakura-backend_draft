const pool          = require("../config/db");
const { askGemini } = require("../services/geminiService");
const { classifyIntent } = require("../utils/chatIntent");

// FIX: naikkan cache TTL dari 3 menit → 10 menit.
// Pertanyaan yang sama dalam 10 menit langsung balik dari cache, 0 panggilan Gemini.
const cache     = new Map();
const CACHE_TTL = 10 * 60 * 1000;

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

// ── Rate limiter per user: min 3 detik antar request ─────────────────────────
// FIX: tambah rate limit di level controller agar user tidak spam tombol kirim.
const userLastRequest = new Map();
const USER_RATE_MS    = 3000;

function isUserRateLimited(userId) {
  const last = userLastRequest.get(userId);
  return last && (Date.now() - last) < USER_RATE_MS;
}
function markUserRequest(userId) {
  userLastRequest.set(userId, Date.now());
  if (userLastRequest.size > 500) {
    const cutoff = Date.now() - 60000;
    for (const [k, v] of userLastRequest) { if (v < cutoff) userLastRequest.delete(k); }
  }
}

// ── System prompt (singkat untuk hemat token) ─────────────────────────────────
const BASE_SYSTEM_PROMPT = `Kamu adalah SAKURA AI, asisten manajemen dokumen sekolah.
Jawab HANYA berdasarkan DATA SISTEM di bawah. Jangan mengarang data.
Bahasa Indonesia, singkat, ramah, solutif. Gunakan poin jika lebih dari 1 item.
Jika user hanya bertanya jumlah/statistik/status dokumen, jawab dengan angka atau
ringkasan datanya saja — jangan menyarankan atau menyebutkan halaman/menu lain
kecuali user secara eksplisit meminta diarahkan/dibuka/ditampilkan ke suatu halaman.`;

// ── Helper: strip markdown code fence yang kadang ditambahkan Gemini ──────────
// FIX UTAMA: Gemini sering membungkus respons JSON dengan ```json ... ```
// Sebelumnya tidak di-strip → JSON.parse gagal → raw JSON tampil di chat.
function stripFences(raw) {
  if (!raw || typeof raw !== "string") return raw;
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── Ambil konteks dari DB ─────────────────────────────────────────────────────
async function buildContext(question, user) {
  const ctx      = [];
  const results  = [];
  const lower    = question.toLowerCase();
  const isGuru   = user.role === "Guru";
  const ownerSQL = isGuru ? "AND d.uploaded_by = ?" : "";
  const ownerPrm = isGuru ? [user.id] : [];

  try {
    const [stats] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(d.status='Menunggu')   AS menunggu,
              SUM(d.status='Diarsipkan') AS diarsipkan,
              SUM(d.status='Ditolak')    AS ditolak,
              SUM(d.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))  AS minggu_ini,
              SUM(d.created_at >= DATE_FORMAT(NOW(),'%Y-%m-01'))     AS bulan_ini,
              SUM(DATE(d.created_at) = CURDATE())                    AS hari_ini
       FROM documents d WHERE d.deleted_at IS NULL ${ownerSQL}`,
      ownerPrm
    );
    ctx.push(
      `Statistik: total=${stats[0].total}, menunggu=${stats[0].menunggu}, ` +
      `diarsipkan=${stats[0].diarsipkan}, ditolak=${stats[0].ditolak}, ` +
      `hari_ini=${stats[0].hari_ini}, minggu_ini=${stats[0].minggu_ini}, bulan_ini=${stats[0].bulan_ini}`
    );

    if (/(menunggu|persetujuan|pending|belum)/.test(lower)) {
      const [rows] = await pool.query(
        `SELECT d.id, d.judul, d.nomor_dokumen, u.nama, DATE(d.created_at) AS tgl
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE d.status='Menunggu' AND d.deleted_at IS NULL ${ownerSQL}
         ORDER BY d.created_at DESC LIMIT 5`,
        ownerPrm
      );
      ctx.push(rows.length
        ? "Dokumen menunggu:\n" + rows.map(r => `- ${r.judul} (${r.nomor_dokumen}) oleh ${r.nama} [${r.tgl}]`).join("\n")
        : "Tidak ada dokumen menunggu.");
      for (const r of rows)
        results.push({ type: "document", id: r.id, judul: r.judul, nomor: r.nomor_dokumen, status: "Menunggu" });
    }

    if (/(cari|temukan|SK|surat|kurikulum)/.test(lower)) {
      const kw = question.replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);
      if (kw.length) {
        const likes  = kw.map(() => "(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)").join(" OR ");
        const params = kw.flatMap(k => [`%${k}%`, `%${k}%`]);
        const [rows] = await pool.query(
          `SELECT d.id, d.judul, d.nomor_dokumen, d.status, u.nama, DATE(d.created_at) AS tgl
           FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
           WHERE d.deleted_at IS NULL AND (${likes}) ${ownerSQL}
           ORDER BY d.created_at DESC LIMIT 5`,
          [...params, ...ownerPrm]
        );
        ctx.push(rows.length
          ? "Hasil cari:\n" + rows.map(r => `- ${r.judul} | ${r.nomor_dokumen} | ${r.status} | ${r.nama} | ${r.tgl}`).join("\n")
          : "Tidak ditemukan dokumen yang cocok.");
        for (const r of rows)
          results.push({ type: "document", id: r.id, judul: r.judul, nomor: r.nomor_dokumen, status: r.status });
      }
    }

    if (/(siapa|upload|mengupload|admin)/.test(lower)) {
      const [rows] = await pool.query(
        `SELECT d.id, u.nama, u.role, d.judul, DATE(d.created_at) AS tgl
         FROM documents d JOIN users u ON u.id = d.uploaded_by
         WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 5`
      );
      if (rows.length) {
        ctx.push("Upload terbaru:\n" + rows.map(r => `- ${r.nama}(${r.role}): "${r.judul}" [${r.tgl}]`).join("\n"));
        for (const r of rows)
          results.push({ type: "document", id: r.id, judul: r.judul, nomor: null, status: null });
      }
    }
  } catch (e) {
    console.error("[Chatbot] buildContext error:", e.message);
  }

  return { text: ctx.join("\n"), results };
}

function friendlyError(err) {
  const msg = err.message || "";
  if (msg.includes("GEMINI_API_KEY")) return "Layanan AI belum dikonfigurasi. Hubungi administrator.";
  if (msg.includes("GEMINI_403"))     return "API Key tidak memiliki izin akses Gemini.";
  if (msg.includes("GEMINI_429"))     return "Layanan AI sedang sibuk. Silakan coba lagi dalam beberapa detik.";
  if (msg.includes("GEMINI_TIMEOUT") || msg.includes("Timeout")) return "AI membutuhkan waktu lebih lama. Silakan coba lagi.";
  return "Terjadi kesalahan saat menghubungi AI. Silakan coba lagi.";
}

// ── POST /api/chatbot ─────────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Pesan tidak boleh kosong." });

    // FIX: cek rate limit per user sebelum panggil Gemini
    const userId = req.user?.id || req.ip;
    if (isUserRateLimited(userId)) {
      return res.status(429).json({ error: "Mohon tunggu sebentar sebelum mengirim pesan berikutnya." });
    }

    const trimmed  = message.trim().slice(0, 300);
    const cacheKey = `${req.user?.role}:${trimmed.toLowerCase()}`;

    const cached = getCached(cacheKey);
    if (cached) {
      markUserRequest(userId);
      return res.json({ answer: cached.answer, links: cached.links || [], fromCache: true });
    }

    markUserRequest(userId);

    const context      = await buildContext(trimmed, req.user);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nDATA SISTEM:\n${context.text}`;

    // Instruksi JSON — Gemini HANYA bertugas menjawab teks. Keputusan
    // "tampilkan tombol navigasi atau tidak" & "link mana yang benar" TIDAK
    // lagi diserahkan ke Gemini (lihat utils/chatIntent.js) — supaya hasilnya
    // konsisten dan tidak bergantung pada tebakan AI per request.
    const jsonInstruction =
      `\n\nBALAS HANYA dengan JSON valid (tanpa teks lain, tanpa markdown fence):\n` +
      `{"text":"<jawaban>"}`;

    const raw = await askGemini(systemPrompt + jsonInstruction, trimmed);

    // FIX: strip markdown fence SEBELUM parse
    const cleaned = stripFences(raw);

    let parsed     = null;
    let answerText = cleaned;

    // Coba parse JSON
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: coba ekstrak substring JSON dari { sampai }
      const fb = cleaned.indexOf("{");
      const lb = cleaned.lastIndexOf("}");
      if (fb !== -1 && lb > fb) {
        try { parsed = JSON.parse(cleaned.slice(fb, lb + 1)); } catch { parsed = null; }
      }
    }

    if (parsed && typeof parsed.text === "string") {
      answerText = parsed.text;
    }
    // Kalau JSON tidak valid, `answerText` tetap berisi teks mentah dari
    // Gemini (cleaned) — dijawab apa adanya, tanpa scan path/keyword apapun
    // dari teks tersebut. Link navigasi murni berasal dari classifyIntent()
    // di bawah, berbasis PERTANYAAN USER, bukan jawaban AI.

    // ── Intent detection & route mapping (deterministik, backend-only) ────
    const intent = classifyIntent(trimmed);
    let links = [];
    if (intent.type !== "information" && intent.link) {
      links.push({ label: intent.link.label, path: intent.link.path });
    }

    // Tambah link langsung ke dokumen dari DB (hasil pencarian/menunggu),
    // tetap tampil apa adanya karena ini link ke dokumen spesifik, bukan
    // tombol navigasi halaman umum.
    if (context.results?.length) {
      for (const r of context.results) {
        if (r.type === "document" && r.id) {
          const p = `/documents/${r.id}`;
          if (!links.some(l => l.path === p))
            links.push({ label: `Buka dokumen: ${r.judul || r.id}`, path: p });
        }
      }
    }

    if (!answerText || answerText.trim() === "" || answerText.startsWith("{")) {
      answerText = "Maaf, sistem sedang sibuk. Silakan coba lagi.";
    }

    setCache(cacheKey, { answer: answerText, links });
    res.json({ answer: answerText, links });

  } catch (e) {
    console.error("[Chatbot] error:", { message: e.message, userId: req.user?.id, role: req.user?.role });
    res.status(502).json({ error: friendlyError(e) });
  }
}

module.exports = { handleChat };