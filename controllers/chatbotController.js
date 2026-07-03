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
Bahasa Indonesia, singkat, ramah, positif, dan solutif. Gunakan poin jika lebih dari 1 item.
Jika data yang diminta tidak tersedia di DATA SISTEM, JANGAN pernah bilang "tidak memiliki
informasi spesifik" atau "berdasarkan data sistem saat ini" secara negatif. Sebagai gantinya,
jelaskan langkah atau fitur terkait yang bisa dilakukan pengguna, dan arahkan mereka ke halaman
yang relevan (sertakan path di dalam kurung, contoh: "Silakan buka halaman Upload Dokumen (/upload)").
Jangan pernah menyoroti keterbatasan data secara negatif.`;

// NOTE: When instructing the user to go to an internal page, include the relative
// path in the response in parentheses, e.g. "Silakan buka halaman Upload Dokumen (/upload)".
// Frontend will detect such paths and render a quick navigation button.

// ── Ambil konteks dari DB ──────────────────────────────────────────────────────
async function buildContext(question, user) {
  const ctx = [];
  const results = [];
  const lower = question.toLowerCase();
  const ownerClause = user.role === "Guru" ? "AND d.uploaded_by = ?" : "";
  const ownerParam = user.role === "Guru" ? [user.id] : [];

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
        `SELECT d.id, d.judul, d.nomor_dokumen, u.nama, DATE(d.created_at) AS tgl
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE d.status='Menunggu' AND d.deleted_at IS NULL ${ownerClause}
         ORDER BY d.created_at DESC LIMIT 5`,
        ownerParam
      );
      ctx.push(rows.length
        ? "Dokumen menunggu:\n" + rows.map((r) => `- ${r.judul} (${r.nomor_dokumen}) oleh ${r.nama} [${r.tgl}]`).join("\n")
        : "Tidak ada dokumen menunggu.");
      // add structured results
      for (const r of rows) results.push({ type: "document", id: r.id, judul: r.judul, nomor: r.nomor_dokumen, status: "Menunggu" });
    }

    // Pencarian keyword
    if (/(cari|temukan|SK|surat|kurikulum)/.test(lower)) {
      const kw = question.replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
      if (kw.length) {
        const likes  = kw.map(() => "(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)").join(" OR ");
        const params = kw.flatMap((k) => [`%${k}%`, `%${k}%`]);
        const [rows] = await pool.query(
          `SELECT d.id, d.judul, d.nomor_dokumen, d.status, u.nama, DATE(d.created_at) AS tgl
           FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
           WHERE d.deleted_at IS NULL AND (${likes}) ${ownerClause}
           ORDER BY d.created_at DESC LIMIT 5`,
          [...params, ...ownerParam]
        );
        ctx.push(rows.length
          ? "Hasil cari:\n" + rows.map((r) => `- ${r.judul} | ${r.nomor_dokumen} | ${r.status} | ${r.nama} | ${r.tgl}`).join("\n")
          : "Tidak ditemukan dokumen yang cocok.");
        for (const r of rows) results.push({ type: "document", id: r.id, judul: r.judul, nomor: r.nomor_dokumen, status: r.status });
      }
    }

    // Upload terbaru / siapa upload
    if (/(siapa|upload|mengupload|admin)/.test(lower)) {
      const [rows] = await pool.query(
        `SELECT d.id, u.nama, u.role, d.judul, DATE(d.created_at) AS tgl
         FROM documents d JOIN users u ON u.id = d.uploaded_by
         WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 5`
      );
      if (rows.length) {
        ctx.push("Upload terbaru:\n" + rows.map((r) => `- ${r.nama}(${r.role}): "${r.judul}" [${r.tgl}]`).join("\n"));
        for (const r of rows) results.push({ type: "document", id: r.id, judul: r.judul, nomor: r.nomor_dokumen || null, status: null });
      }
    }

  } catch (e) {
    console.error("[Chatbot] buildContext error:", e.message);
  }

  return { text: ctx.join("\n"), results };
}

function friendlyError(err) {
  const msg = err.message || "";
  if (msg.includes("GEMINI_API_KEY"))  return "Layanan AI belum dikonfigurasi. Hubungi administrator.";
  if (msg.includes("GEMINI_403"))      return "API Key tidak memiliki izin akses Gemini.";
  if (msg.includes("GEMINI_429"))      return "Mohon maaf, SAKURA AI sedang memproses banyak permintaan. Silakan coba kembali beberapa saat lagi.";
  if (msg.includes("GEMINI_TIMEOUT"))  return "Mohon maaf, SAKURA AI membutuhkan waktu lebih lama dari biasanya. Silakan coba kembali beberapa saat lagi.";
  if (msg.includes("Timeout"))         return "Mohon maaf, SAKURA AI membutuhkan waktu lebih lama dari biasanya. Silakan coba kembali beberapa saat lagi.";
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
    if (cached) return res.json({ answer: cached.answer, links: cached.links || [], fromCache: true });

    const context = await buildContext(trimmed, req.user);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\nDATA SISTEM:\n${context.text}`;

    // Ask the model to return a JSON object ONLY with fields: text (string) and links (array of {label,path}).
    // Example: {"text":"Jawaban singkat...","links":[{"label":"Buka /upload","path":"/upload"}]}
    const jsonInstruction = `\n\nPENTING: Keluarkan jawaban dalam FORMAT JSON SAJA (tanpa teks tambahan) dengan schema:\n` +
      `{"text":"<jawaban singkat dalam bahasa Indonesia>", "links":[{"label":"<label>","path":"/<route>"}] }` +
      `\nJika tidak ada link, gunakan "links": [] . Pastikan output adalah valid JSON.`;

    const raw = await askGemini(systemPrompt + jsonInstruction, trimmed);

    let parsed = null;
    let answerText = String(raw);
    let links = [];

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // If parsing fails, try to extract a JSON substring
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const maybe = raw.slice(firstBrace, lastBrace + 1);
        try { parsed = JSON.parse(maybe); } catch (_) { parsed = null; }
      }
    }

    if (parsed && typeof parsed.text === 'string') {
      answerText = parsed.text;
      if (Array.isArray(parsed.links)) {
        // sanitize paths
        links = parsed.links.map(l => ({ label: String(l.label || `Buka ${l.path || ''}`).trim(), path: String(l.path || '').trim() })).filter(l => l.path);
      }
    } else {
      // fallback: extract relative paths and keywords as before
      const pathRegex = /\/(?:[a-z0-9\-_/]+)/gi;
      const foundPaths = Array.from(new Set((String(answerText).match(pathRegex) || []).map(p => p.trim())));

      const routeMap = [
        { keys: ["upload dokumen", "halaman upload", "upload"], path: "/upload" },
        { keys: ["dashboard", "statistik", "statistik dokumen"], path: "/dashboard" },
        { keys: ["arsip", "archive", "arsip digital"], path: "/archive" },
        { keys: ["persetujuan", "approval", "menunggu"], path: "/approval" },
        { keys: ["persetujuan pending", "approval pending", "menunggu"], path: "/approval/pending" },
        { keys: ["persetujuan disetujui", "approved", "approval approved"], path: "/approval/approved" },
        { keys: ["profil", "profile"], path: "/profile" },
        { keys: ["ganti password", "change password", "ubah kata sandi"], path: "/change-password" },
        { keys: ["pengguna", "users", "manajemen pengguna"], path: "/users" },
        { keys: ["peran", "roles", "manajemen peran"], path: "/roles" },
        { keys: ["log", "logs", "riwayat"], path: "/logs" },
        { keys: ["sampah", "trash"], path: "/trash" },
        { keys: ["pengaturan", "settings"], path: "/settings" },
        { keys: ["beranda", "home", "halaman beranda"], path: "/home" },
      ];

      const lower = String(answerText).toLowerCase();
      const keywordPaths = [];
      for (const m of routeMap) {
        if (m.keys.some(k => lower.includes(k))) {
          if (!foundPaths.includes(m.path)) keywordPaths.push(m.path);
        }
      }

      links = Array.from(new Set([...foundPaths, ...keywordPaths])).map(p => ({ label: `Buka ${p}`, path: p }));
    }

    // include any document results found in the DB as direct links
    if (context.results && context.results.length) {
      for (const r of context.results) {
        if (r.type === "document" && r.id) {
          const p = `/documents/${r.id}`;
          if (!links.some((l) => l.path === p)) links.push({ label: `Buka dokumen: ${r.judul || r.nomor || r.id}`, path: p });
        }
      }
    }

    setCache(cacheKey, { answer: answerText, links });
    res.json({ answer: answerText, links });
  } catch (e) {
    console.error("[Chatbot] error:", {
      message: e.message,
      userId: req.user?.id,
      role: req.user?.role,
    });
    res.status(502).json({ error: friendlyError(e) });
  }
}

module.exports = { handleChat };