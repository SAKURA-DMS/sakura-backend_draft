const pool = require("../config/db");
const { askGemini } = require("../services/geminiService");
const { classifyIntent } = require("../utils/chatIntent");

// ============================================================
// CACHE
// ============================================================

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCache(key, value) {
  if (cache.size >= 200) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, {
    value,
    ts: Date.now(),
  });
}

// ============================================================
// SEARCH SESSION
//
// Menyimpan bahwa user baru saja menekan/mengatakan
// "Cari dokumen", sehingga pesan berikutnya seperti
// "Ijazah Iqbal Fachrozi" tetap dianggap query pencarian.
// ============================================================

const searchSessions = new Map();
const SEARCH_SESSION_TTL = 5 * 60 * 1000;

function setSearchSession(userId) {
  searchSessions.set(String(userId), Date.now());
}

function hasSearchSession(userId) {
  const key = String(userId);
  const startedAt = searchSessions.get(key);

  if (!startedAt) return false;

  if (Date.now() - startedAt > SEARCH_SESSION_TTL) {
    searchSessions.delete(key);
    return false;
  }

  return true;
}

function clearSearchSession(userId) {
  searchSessions.delete(String(userId));
}

// ============================================================
// RATE LIMIT PER USER
// ============================================================

const userLastRequest = new Map();
const USER_RATE_MS = 1200;

function isUserRateLimited(userId) {
  const last = userLastRequest.get(userId);

  return Boolean(
    last &&
    Date.now() - last < USER_RATE_MS
  );
}

function markUserRequest(userId) {
  userLastRequest.set(userId, Date.now());

  if (userLastRequest.size > 500) {
    const cutoff = Date.now() - 60000;

    for (const [key, value] of userLastRequest) {
      if (value < cutoff) {
        userLastRequest.delete(key);
      }
    }
  }
}

// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function stripFences(raw) {
  if (!raw || typeof raw !== "string") return raw;

  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function cleanGeminiText(text = "") {
  return String(text)
    // Frontend saat ini bukan markdown renderer.
    // Hilangkan markdown agar **Dashboard** tidak tampil mentah.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

function friendlyError(err) {
  const msg = err?.message || "";

  if (msg.includes("GEMINI_API_KEY")) {
    return "Layanan AI belum dikonfigurasi. Hubungi administrator.";
  }

  if (msg.includes("GEMINI_403")) {
    return "API Key tidak memiliki izin akses Gemini.";
  }

  if (msg.includes("GEMINI_429")) {
    return "Layanan AI sedang sibuk. Silakan coba lagi dalam beberapa detik.";
  }

  if (
    msg.includes("GEMINI_TIMEOUT") ||
    msg.includes("Timeout")
  ) {
    return "AI membutuhkan waktu lebih lama. Silakan coba lagi.";
  }

  return "Terjadi kesalahan saat menghubungi AI. Silakan coba lagi.";
}

// ============================================================
// ROLE HELPERS
// ============================================================

function isGuru(user) {
  return String(user?.role || "").toLowerCase() === "guru";
}

function getOwnerFilter(user, alias = "d") {
  if (isGuru(user)) {
    return {
      sql: `AND ${alias}.uploaded_by = ?`,
      params: [user.id],
    };
  }

  return {
    sql: "",
    params: [],
  };
}

// ============================================================
// INTENT DETECTION
// ============================================================

function isStatisticsIntent(text) {
  const lower = normalizeText(text);

  return (
    /\b(statistik|statistic|stats)\b/.test(lower) ||
    /tampilkan statistik dokumen/.test(lower) ||
    /berapa (jumlah|total) dokumen/.test(lower) ||
    /ringkasan dokumen/.test(lower)
  );
}

function isHelpIntent(text) {
  const lower = normalizeText(text);

  return (
    /bagaimana cara menggunakan sakura/.test(lower) ||
    /cara menggunakan sakura/.test(lower) ||
    /bantuan penggunaan/.test(lower) ||
    /panduan penggunaan/.test(lower) ||
    /cara pakai sakura/.test(lower)
  );
}

function isSearchStarter(text) {
  const lower = normalizeText(text);

  return (
    lower === "cari dokumen" ||
    lower === "saya ingin mencari dokumen" ||
    lower === "ingin mencari dokumen" ||
    lower === "mau mencari dokumen" ||
    lower === "saya mau mencari dokumen" ||
    lower === "temukan dokumen"
  );
}

function isExplicitDocumentSearch(text) {
  const lower = normalizeText(text);

  return (
    /^(cari|carikan|temukan|tolong cari|tolong carikan)\b/.test(lower) ||
    /\bcari dokumen\b/.test(lower) ||
    /\btemukan dokumen\b/.test(lower)
  );
}

function extractSearchQuery(text) {
  return String(text)
    .replace(
      /^(tolong\s+)?(cari|carikan|temukan)\s+(dokumen\s+)?/i,
      ""
    )
    .replace(/^dokumen\s+/i, "")
    .trim();
}

// ============================================================
// DATABASE: STATISTICS
// ============================================================

async function getStatistics(user) {
  const owner = getOwnerFilter(user);

  const [rows] = await pool.query(
    `
      SELECT
        COUNT(*) AS total,

        COALESCE(
          SUM(d.status = 'Menunggu'),
          0
        ) AS menunggu,

        COALESCE(
          SUM(d.status = 'Diarsipkan'),
          0
        ) AS diarsipkan,

        COALESCE(
          SUM(d.status = 'Ditolak'),
          0
        ) AS ditolak,

        COALESCE(
          SUM(DATE(d.created_at) = CURDATE()),
          0
        ) AS hari_ini,

        COALESCE(
          SUM(
            d.created_at >= DATE_SUB(
              CURDATE(),
              INTERVAL 7 DAY
            )
          ),
          0
        ) AS minggu_ini,

        COALESCE(
          SUM(
            d.created_at >= DATE_FORMAT(
              NOW(),
              '%Y-%m-01'
            )
          ),
          0
        ) AS bulan_ini

      FROM documents d

      WHERE
        d.deleted_at IS NULL
        ${owner.sql}
    `,
    owner.params
  );

  const row = rows?.[0] || {};

  return {
    total: Number(row.total || 0),
    menunggu: Number(row.menunggu || 0),
    diarsipkan: Number(row.diarsipkan || 0),
    ditolak: Number(row.ditolak || 0),
    hari_ini: Number(row.hari_ini || 0),
    minggu_ini: Number(row.minggu_ini || 0),
    bulan_ini: Number(row.bulan_ini || 0),
  };
}

function buildStatisticsAnswer(stats) {
  return [
    "Berikut statistik dokumen saat ini:",
    "",
    `• Total dokumen: ${stats.total}`,
    `• Menunggu persetujuan: ${stats.menunggu}`,
    `• Sudah diarsipkan: ${stats.diarsipkan}`,
    `• Ditolak: ${stats.ditolak}`,
    "",
    "Dokumen yang diajukan:",
    `• Hari ini: ${stats.hari_ini}`,
    `• 7 hari terakhir: ${stats.minggu_ini}`,
    `• Bulan ini: ${stats.bulan_ini}`,
    "",
    "Kamu juga bisa melihat grafik dan ringkasan statistik secara lebih lengkap melalui Dashboard.",
  ].join("\n");
}

// ============================================================
// DATABASE: DOCUMENT SEARCH
// ============================================================

async function searchDocuments(query, user) {
  const search = String(query || "").trim();

  if (!search) {
    return [];
  }

  const owner = getOwnerFilter(user);

  // Gunakan query penuh + kata-kata penting.
  // Ini membuat "Ijazah Iqbal Fachrozi" bisa menemukan judul
  // secara langsung tanpa tergantung kata "cari".
  const words = search
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);

  const conditions = [
    "LOWER(d.judul) LIKE LOWER(?)",
    "LOWER(d.nomor_dokumen) LIKE LOWER(?)",
  ];

  const params = [
    `%${search}%`,
    `%${search}%`,
  ];

  for (const word of words.slice(0, 6)) {
    conditions.push("LOWER(d.judul) LIKE LOWER(?)");
    params.push(`%${word}%`);
  }

  const [rows] = await pool.query(
    `
      SELECT
        d.id,
        d.judul,
        d.nomor_dokumen,
        d.status,
        d.created_at,
        u.nama AS uploader

      FROM documents d

      LEFT JOIN users u
        ON u.id = d.uploaded_by

      WHERE
        d.deleted_at IS NULL

        AND (
          ${conditions.join(" OR ")}
        )

        ${owner.sql}

      ORDER BY

        CASE
          WHEN LOWER(d.judul) = LOWER(?) THEN 0
          WHEN LOWER(d.judul) LIKE LOWER(?) THEN 1
          ELSE 2
        END,

        d.created_at DESC

      LIMIT 10
    `,
    [
      ...params,
      ...owner.params,
      search,
      `%${search}%`,
    ]
  );

  return rows || [];
}

function buildSearchAnswer(query, documents) {
  if (!documents.length) {
    return [
      `Tidak ditemukan dokumen yang cocok dengan pencarian "${query}".`,
      "",
      "Coba gunakan judul dokumen, nomor dokumen, atau kata kunci lain yang lebih spesifik.",
    ].join("\n");
  }

  const lines = [
    `Ditemukan ${documents.length} dokumen yang cocok dengan pencarian "${query}":`,
    "",
  ];

  documents.forEach((doc, index) => {
    lines.push(`${index + 1}. ${doc.judul}`);

    if (doc.nomor_dokumen) {
      lines.push(`   Nomor: ${doc.nomor_dokumen}`);
    }

    lines.push(`   Status: ${doc.status || "-"}`);

    if (doc.uploader) {
      lines.push(`   Diunggah oleh: ${doc.uploader}`);
    }

    if (index !== documents.length - 1) {
      lines.push("");
    }
  });

  lines.push("");
  lines.push(
    "Pilih tombol dokumen di bawah untuk melihat detailnya."
  );

  return lines.join("\n");
}

function buildDocumentLinks(documents) {
  return documents
    .filter((doc) => doc?.id)
    .map((doc) => ({
      label: `Buka dokumen: ${doc.judul} (${doc.status || "Tanpa status"})`,
      path: `/documents/${doc.id}`,
    }));
}

// ============================================================
// HELP / GUIDE
// ============================================================

function buildHelpAnswer(user) {
  const role = String(user?.role || "");

  const lines = [
    "SAKURA digunakan untuk mengelola arsip dokumen sekolah secara digital.",
    "",
    "Fitur utama yang dapat digunakan:",
    "",
    "• Dashboard",
    "Melihat ringkasan jumlah dokumen, status dokumen, dan grafik statistik.",
    "",
    "• Upload Dokumen",
    "Menambahkan dokumen baru ke sistem untuk diproses sesuai alur persetujuan.",
    "",
    "• Arsip Digital",
    "Mencari dan membuka dokumen yang telah tersimpan di sistem.",
    "",
    "• Persetujuan",
    "Memeriksa dokumen yang menunggu proses persetujuan sesuai hak akses pengguna.",
    "",
    "• Notifikasi",
    "Melihat pemberitahuan ketika terdapat perubahan atau proses pada dokumen.",
  ];

  if (
    /admin|operator|tu|kepala/i.test(role)
  ) {
    lines.push(
      "",
      "Beberapa menu tambahan tersedia sesuai peran akun, seperti manajemen pengguna, log aktivitas, atau pengelolaan persetujuan."
    );
  }

  lines.push(
    "",
    "Kamu bisa memilih salah satu tombol di bawah untuk membuka halaman yang dibutuhkan."
  );

  return lines.join("\n");
}

function buildHelpLinks(user) {
  const links = [
    {
      label: "Buka Dashboard",
      path: "/dashboard",
    },
    {
      label: "Buka halaman Upload",
      path: "/upload",
    },
    {
      label: "Buka Arsip",
      path: "/archive",
    },
  ];

  const role = String(user?.role || "");

  if (
    /admin|operator|tu|kepala/i.test(role)
  ) {
    links.push({
      label: "Buka Persetujuan",
      path: "/approval",
    });
  }

  return links;
}

// ============================================================
// GEMINI CONTEXT
// ============================================================

const BASE_SYSTEM_PROMPT = `
Kamu adalah SAKURA AI, asisten resmi sistem SAKURA
(Secure Archiving and Keeping of Unified Records for Administration),
sistem manajemen arsip digital SMP Negeri 4 Cikarang Barat.

TUGAS:
- Membantu pengguna memahami penggunaan sistem SAKURA.
- Menjawab pertanyaan mengenai dokumen berdasarkan DATA SISTEM
  yang diberikan backend.
- Membantu navigasi dan penggunaan fitur SAKURA.

ATURAN:
1. Gunakan Bahasa Indonesia yang sopan, ramah, jelas, dan ringkas.
2. Jangan mengarang nama dokumen, jumlah dokumen, status,
   pengguna, atau informasi database.
3. Jika DATA SISTEM tidak menyediakan fakta tertentu,
   katakan bahwa informasi tersebut tidak tersedia.
4. Jangan pernah mengaku sudah membuka halaman.
5. Jika pengguna meminta navigasi, jelaskan singkat tujuan halaman.
   Tombol navigasi akan dibuat oleh backend.
6. Jangan gunakan Markdown seperti **tebal**, heading #,
   tabel markdown, atau code fence.
7. Gunakan bullet "•" jika perlu.
8. Jangan menampilkan path teknis seperti /upload dalam jawaban
   kecuali benar-benar diperlukan.
9. Jangan memberikan kredensial, API key, source code sensitif,
   atau data keamanan internal.

FITUR SAKURA:
• Dashboard: ringkasan dan grafik statistik dokumen.
• Upload: menambahkan dokumen baru.
• Arsip: melihat dan mencari dokumen.
• Persetujuan: memproses dokumen sesuai hak akses.
• Notifikasi: pemberitahuan aktivitas/status.
• Profil: pengelolaan profil pengguna.
• Pengguna dan Peran: tersedia sesuai hak akses.
• Log Aktivitas: audit trail aktivitas sistem.
`.trim();

async function buildGeneralContext(user) {
  try {
    const stats = await getStatistics(user);

    return [
      `Peran pengguna saat ini: ${user?.role || "Tidak diketahui"}`,
      "",
      "Statistik database saat ini:",
      `Total: ${stats.total}`,
      `Menunggu: ${stats.menunggu}`,
      `Diarsipkan: ${stats.diarsipkan}`,
      `Ditolak: ${stats.ditolak}`,
    ].join("\n");
  } catch (error) {
    console.error(
      "[Chatbot] buildGeneralContext error:",
      error.message
    );

    return `Peran pengguna saat ini: ${
      user?.role || "Tidak diketahui"
    }`;
  }
}

async function askGeminiSafely(question, user) {
  const context = await buildGeneralContext(user);

  const systemPrompt = [
    BASE_SYSTEM_PROMPT,
    "",
    "DATA SISTEM:",
    context,
    "",
    "Balas hanya dalam JSON valid tanpa markdown fence:",
    '{"text":"jawaban"}',
  ].join("\n");

  const raw = await askGemini(
    systemPrompt,
    question
  );

  const cleaned = stripFences(raw);

  let answerText = cleaned;

  try {
    const parsed = JSON.parse(cleaned);

    if (
      parsed &&
      typeof parsed.text === "string"
    ) {
      answerText = parsed.text;
    }
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (
      firstBrace !== -1 &&
      lastBrace > firstBrace
    ) {
      try {
        const parsed = JSON.parse(
          cleaned.slice(
            firstBrace,
            lastBrace + 1
          )
        );

        if (
          parsed &&
          typeof parsed.text === "string"
        ) {
          answerText = parsed.text;
        }
      } catch {
        // gunakan raw cleaned text
      }
    }
  }

  return cleanGeminiText(answerText);
}

// ============================================================
// NAVIGATION
// ============================================================

function getNavigationLinks(question) {
  try {
    const intent = classifyIntent(question);

    if (
      intent &&
      intent.type !== "information" &&
      intent.link
    ) {
      return [
        {
          label: intent.link.label,
          path: intent.link.path,
        },
      ];
    }
  } catch (error) {
    console.error(
      "[Chatbot] classifyIntent error:",
      error.message
    );
  }

  return [];
}

// ============================================================
// MAIN CONTROLLER
// POST /api/chatbot
// ============================================================

async function handleChat(req, res) {
  try {
    const { message } = req.body;

    if (
      !message ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      return res.status(400).json({
        error: "Pesan tidak boleh kosong.",
      });
    }

    const trimmed = message
      .trim()
      .slice(0, 500);

    const userId =
      req.user?.id ||
      req.ip ||
      "anonymous";

    // --------------------------------------------------------
    // Rate limit
    // --------------------------------------------------------

    if (isUserRateLimited(userId)) {
      return res.status(429).json({
        error:
          "Mohon tunggu sebentar sebelum mengirim pesan berikutnya.",
      });
    }

    markUserRequest(userId);

    // ========================================================
    // 1. SEARCH STARTER
    // ========================================================

    if (isSearchStarter(trimmed)) {
      setSearchSession(userId);

      return res.json({
        answer: [
          "Tentu 🌸",
          "",
          "Silakan masukkan judul, nomor dokumen, atau kata kunci dokumen yang ingin dicari.",
          "",
          "Contoh: Ijazah Iqbal Fachrozi",
        ].join("\n"),
        links: [],
        mode: "document_search",
      });
    }

    // ========================================================
    // 2. FOLLOW-UP SEARCH
    // ========================================================

    if (hasSearchSession(userId)) {
      clearSearchSession(userId);

      const documents = await searchDocuments(
        trimmed,
        req.user
      );

      return res.json({
        answer: buildSearchAnswer(
          trimmed,
          documents
        ),
        links: buildDocumentLinks(documents),
        results: documents.map((doc) => ({
          id: doc.id,
          judul: doc.judul,
          nomor: doc.nomor_dokumen,
          status: doc.status,
        })),
      });
    }

    // ========================================================
    // 3. EXPLICIT DOCUMENT SEARCH
    // ========================================================

    if (isExplicitDocumentSearch(trimmed)) {
      const query = extractSearchQuery(trimmed);

      if (!query) {
        setSearchSession(userId);

        return res.json({
          answer:
            "Silakan masukkan judul, nomor dokumen, atau kata kunci dokumen yang ingin dicari.",
          links: [],
          mode: "document_search",
        });
      }

      const documents = await searchDocuments(
        query,
        req.user
      );

      return res.json({
        answer: buildSearchAnswer(
          query,
          documents
        ),
        links: buildDocumentLinks(documents),
        results: documents.map((doc) => ({
          id: doc.id,
          judul: doc.judul,
          nomor: doc.nomor_dokumen,
          status: doc.status,
        })),
      });
    }

    // ========================================================
    // 4. STATISTICS
    // ========================================================

    if (isStatisticsIntent(trimmed)) {
      const stats = await getStatistics(req.user);

      return res.json({
        answer: buildStatisticsAnswer(stats),
        links: [
          {
            label: "Buka Dashboard",
            path: "/dashboard",
          },
        ],
        statistics: stats,
      });
    }

    // ========================================================
    // 5. HELP / HOW TO USE SAKURA
    // ========================================================

    if (isHelpIntent(trimmed)) {
      return res.json({
        answer: buildHelpAnswer(req.user),
        links: buildHelpLinks(req.user),
      });
    }

    // ========================================================
    // 6. NAVIGATION
    //
    // Contoh:
    // "antar saya ke upload"
    // "buka halaman arsip"
    // ========================================================

    const navigationLinks =
      getNavigationLinks(trimmed);

    if (navigationLinks.length > 0) {
      const lower = normalizeText(trimmed);

      let answer =
        "Tentu. Gunakan tombol di bawah untuk membuka halaman yang kamu butuhkan.";

      if (
        lower.includes("upload")
      ) {
        answer =
          "Tentu. Buka halaman Upload untuk menambahkan dokumen baru.";
      } else if (
        lower.includes("dashboard") ||
        lower.includes("statistik")
      ) {
        answer =
          "Tentu. Buka Dashboard untuk melihat ringkasan dan grafik statistik dokumen.";
      } else if (
        lower.includes("arsip")
      ) {
        answer =
          "Tentu. Buka halaman Arsip untuk melihat dan mencari dokumen.";
      } else if (
        lower.includes("persetujuan") ||
        lower.includes("approval")
      ) {
        answer =
          "Tentu. Buka halaman Persetujuan untuk melihat dokumen yang memerlukan proses persetujuan.";
      }

      return res.json({
        answer,
        links: navigationLinks,
      });
    }

    // ========================================================
    // 7. GENERAL AI QUESTION -> GEMINI
    // ========================================================

    const cacheKey = [
      req.user?.id || "",
      req.user?.role || "",
      normalizeText(trimmed),
    ].join(":");

    const cached = getCached(cacheKey);

    if (cached) {
      return res.json({
        ...cached,
        fromCache: true,
      });
    }

    const answerText =
      await askGeminiSafely(
        trimmed,
        req.user
      );

    const response = {
      answer:
        answerText ||
        "Maaf, saya belum dapat memproses pertanyaan tersebut.",
      links: [],
    };

    setCache(
      cacheKey,
      response
    );

    return res.json(response);

  } catch (error) {
    console.error(
      "[Chatbot] error:",
      {
        message: error?.message,
        stack: error?.stack,
        userId: req.user?.id,
        role: req.user?.role,
      }
    );

    return res.status(502).json({
      error: friendlyError(error),
    });
  }
}

module.exports = {
  handleChat,
};