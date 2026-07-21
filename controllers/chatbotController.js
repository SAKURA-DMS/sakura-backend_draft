const pool = require("../config/db");
const { askGemini } = require("../services/geminiService");
const { classifyIntent } = require("../utils/chatIntent");

// ============================================================
// CACHE GEMINI
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
// RATE LIMIT
//
// HANYA untuk Gemini.
// Search, statistics, help, navigation TIDAK terkena rate limit.
// ============================================================

const userLastGeminiRequest = new Map();
const GEMINI_USER_RATE_MS = 1200;

function isGeminiRateLimited(userId) {
  const key = String(userId);
  const last = userLastGeminiRequest.get(key);

  return Boolean(
    last &&
    Date.now() - last < GEMINI_USER_RATE_MS
  );
}

function markGeminiRequest(userId) {
  const key = String(userId);

  userLastGeminiRequest.set(
    key,
    Date.now()
  );

  if (userLastGeminiRequest.size > 500) {
    const cutoff = Date.now() - 60000;

    for (const [storedKey, value] of userLastGeminiRequest) {
      if (value < cutoff) {
        userLastGeminiRequest.delete(storedKey);
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
  if (!raw || typeof raw !== "string") {
    return raw;
  }

  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function cleanGeminiText(text = "") {
  return String(text)
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
    return "API Key Gemini tidak memiliki izin yang diperlukan.";
  }

  if (msg.includes("GEMINI_429")) {
    return "Layanan AI sedang menerima banyak permintaan. Silakan coba lagi sebentar.";
  }

  if (
    msg.includes("GEMINI_TIMEOUT") ||
    msg.includes("Timeout")
  ) {
    return "AI membutuhkan waktu lebih lama untuk merespons. Silakan coba lagi.";
  }

  return "Terjadi kesalahan saat menghubungi AI. Silakan coba lagi.";
}

// ============================================================
// ROLE
// ============================================================

function getRoleName(user) {
  return String(
    user?.role ||
    user?.role_name ||
    ""
  ).toLowerCase();
}

function isGuru(user) {
  return getRoleName(user) === "guru";
}

function getOwnerFilter(user, alias = "d") {
  /*
   * Guru hanya melihat dokumen miliknya sendiri.
   * Operator/TU, Kepsek, Admin melihat dokumen sesuai akses sistem.
   */

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
    /lihat statistik dokumen/.test(lower) ||
    /berapa (jumlah|total) dokumen/.test(lower) ||
    /ringkasan dokumen/.test(lower)
  );
}

function isHelpIntent(text) {
  const lower = normalizeText(text);

  return (
    /bagaimana cara menggunakan sakura/.test(lower) ||
    /cara menggunakan sakura/.test(lower) ||
    /cara pakai sakura/.test(lower) ||
    /bantuan penggunaan/.test(lower) ||
    /panduan penggunaan/.test(lower) ||
    /fitur sakura/.test(lower)
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
    /^(cari|carikan|temukan|tolong cari|tolong carikan)\b/.test(
      lower
    ) ||
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
// STATISTICS
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
    "Berikut ringkasan statistik dokumen saat ini:",
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
    "Untuk melihat grafik dan statistik lebih lengkap, buka Dashboard melalui tombol di bawah.",
  ].join("\n");
}

// ============================================================
// DOCUMENT SEARCH
// ============================================================

async function searchDocuments(query, user) {
  const search = String(query || "").trim();

  if (!search) {
    return [];
  }

  const owner = getOwnerFilter(user);

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
    conditions.push(
      "LOWER(d.judul) LIKE LOWER(?)"
    );

    params.push(
      `%${word}%`
    );
  }

  const [rows] = await pool.query(
    `
      SELECT
        d.id,
        d.judul,
        d.nomor_dokumen,
        d.status,
        d.created_at,
        d.uploaded_by,
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

  if (documents.length === 1) {
    const doc = documents[0];

    return [
      `Ditemukan dokumen "${doc.judul}".`,
      "",
      `Nomor dokumen: ${doc.nomor_dokumen || "-"}`,
      `Status: ${doc.status || "-"}`,
      doc.uploader
        ? `Diunggah oleh: ${doc.uploader}`
        : null,
      "",
      "Gunakan tombol di bawah untuk membuka dokumen.",
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  return [
    `Ditemukan ${documents.length} dokumen yang cocok dengan pencarian "${query}".`,
    "",
    "Pilih salah satu dokumen melalui tombol di bawah untuk melihat detailnya.",
  ].join("\n");
}

/*
 * PENTING:
 *
 * Semua status tetap dibuatkan tombol:
 * - Diarsipkan
 * - Ditolak
 * - Menunggu
 *
 * Jadi Ijazah Iqbal yang Ditolak TETAP ditemukan.
 */
function buildDocumentLinks(documents) {
  return documents
    .filter((doc) => doc?.id)
    .map((doc) => {
      let label = `Buka dokumen: ${doc.judul}`;

      /*
       * Pertahankan gaya screenshot lama:
       * dokumen diarsipkan dapat diberi label Buka arsip.
       */
      if (
        String(doc.status || "").toLowerCase() ===
        "diarsipkan"
      ) {
        label = `Buka arsip: ${doc.judul}`;
      }

      return {
        label,
        path: `/documents/${doc.id}`,
        documentId: doc.id,
        status: doc.status || null,
      };
    });
}

// ============================================================
// HELP / CARA MENGGUNAKAN
// ============================================================

function buildHelpAnswer(user) {
  const role = getRoleName(user);

  const lines = [
    "SAKURA digunakan untuk mengelola arsip dokumen sekolah secara digital.",
    "",
    "Menu utama:",
    "",
    "• Dashboard",
    "Melihat ringkasan dokumen dan grafik statistik.",
    "",
    "• Upload",
    "Menambahkan dokumen baru ke sistem.",
    "",
    "• Arsip",
    "Mencari dan membuka dokumen yang tersimpan.",
    "",
    "• Persetujuan",
    "Memproses dokumen yang menunggu persetujuan sesuai hak akses.",
    "",
    "Gunakan tombol di bawah untuk membuka halaman yang dibutuhkan.",
  ];

  if (
    /admin|operator|tu|kepala/.test(role)
  ) {
    lines.splice(
      lines.length - 1,
      0,
      "",
      "Menu tambahan seperti Pengguna, Peran, dan Log Aktivitas tersedia sesuai hak akses akun."
    );
  }

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
      label: "Buka halaman Arsip",
      path: "/archive",
    },
  ];

  const role = getRoleName(user);

  if (
    /admin|operator|tu|kepala/.test(role)
  ) {
    links.push({
      label: "Buka Persetujuan",
      path: "/approval",
    });
  }

  return links;
}

// ============================================================
// NAVIGATION RESPONSE
// ============================================================

function buildNavigationAnswer(intent) {
  const route = intent?.route;

  switch (route) {
    case "upload":
      return "Tentu. Gunakan tombol di bawah untuk membuka halaman Upload dan menambahkan dokumen baru.";

    case "dashboard":
      return "Tentu. Gunakan tombol di bawah untuk membuka Dashboard dan melihat ringkasan serta grafik statistik dokumen.";

    case "approval":
      return "Tentu. Gunakan tombol di bawah untuk membuka halaman Persetujuan.";

    case "archive":
      return "Tentu. Gunakan tombol di bawah untuk membuka halaman Arsip dan melihat dokumen yang tersimpan.";

    case "users":
      return "Tentu. Gunakan tombol di bawah untuk membuka Manajemen Pengguna.";

    case "roles":
      return "Tentu. Gunakan tombol di bawah untuk membuka Manajemen Peran.";

    case "logs":
      return "Tentu. Gunakan tombol di bawah untuk membuka Log Aktivitas.";

    case "settings":
      return "Tentu. Gunakan tombol di bawah untuk membuka Pengaturan.";

    case "profile":
      return "Tentu. Gunakan tombol di bawah untuk membuka Profil.";

    case "home":
      return "Tentu. Gunakan tombol di bawah untuk membuka Beranda.";

    case "trash":
      return "Tentu. Gunakan tombol di bawah untuk membuka Kotak Sampah.";

    default:
      if (intent?.type === "folder") {
        return "Tentu. Gunakan tombol di bawah untuk membuka folder dokumen yang diminta.";
      }

      return "Tentu. Gunakan tombol di bawah untuk membuka halaman yang kamu butuhkan.";
  }
}

function getNavigationResponse(question) {
  try {
    const intent = classifyIntent(question);

    if (
      !intent ||
      intent.type === "information" ||
      !intent.link
    ) {
      return null;
    }

    return {
      answer: buildNavigationAnswer(intent),
      links: [
        {
          label: intent.link.label,
          path: intent.link.path,
        },
      ],
    };
  } catch (error) {
    console.error(
      "[Chatbot] navigation error:",
      error.message
    );

    return null;
  }
}

// ============================================================
// GEMINI SYSTEM PROMPT
// ============================================================

const BASE_SYSTEM_PROMPT = `
Kamu adalah SAKURA AI, asisten resmi sistem SAKURA
(Secure Archiving and Keeping of Unified Records for Administration),
sistem manajemen arsip digital SMP Negeri 4 Cikarang Barat.

TUGAS:
- Membantu pengguna memahami sistem SAKURA.
- Menjawab pertanyaan umum mengenai penggunaan sistem.
- Menggunakan DATA SISTEM yang diberikan backend jika relevan.

ATURAN PENTING:
1. Gunakan Bahasa Indonesia yang sopan, ramah, jelas, dan ringkas.
2. Jangan mengarang nama dokumen, status, jumlah dokumen, atau data pengguna.
3. Jangan mengatakan dokumen tidak ada jika backend tidak memberikan data pencarian.
4. Jangan mengaku telah membuka atau memindahkan halaman.
5. Navigasi dan tombol dibuat oleh backend, bukan oleh kamu.
6. Jangan membuat URL atau path navigasi sendiri.
7. Jangan menggunakan Markdown seperti **tebal**, heading #, tabel, atau code fence.
8. Gunakan bullet • jika diperlukan.
9. Jangan memberikan API key, kredensial, atau informasi keamanan internal.

FITUR SAKURA:
• Dashboard: ringkasan dan grafik statistik dokumen.
• Upload: menambahkan dokumen baru.
• Arsip: melihat dan mencari dokumen.
• Persetujuan: memproses dokumen sesuai hak akses.
• Notifikasi: pemberitahuan aktivitas dan perubahan status.
• Profil: pengelolaan profil pengguna.
• Pengguna dan Peran: tersedia sesuai hak akses.
• Log Aktivitas: audit trail aktivitas sistem.
• Kotak Sampah: dokumen yang dihapus sementara.
`.trim();

async function buildGeneralContext(user) {
  try {
    const stats = await getStatistics(user);

    return [
      `Peran pengguna saat ini: ${
        user?.role ||
        user?.role_name ||
        "Tidak diketahui"
      }`,
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
      user?.role ||
      user?.role_name ||
      "Tidak diketahui"
    }`;
  }
}

async function askGeminiSafely(
  question,
  user
) {
  const context =
    await buildGeneralContext(user);

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
    const firstBrace =
      cleaned.indexOf("{");

    const lastBrace =
      cleaned.lastIndexOf("}");

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
        // fallback raw text
      }
    }
  }

  return cleanGeminiText(
    answerText
  );
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

    // ========================================================
    // 1. SEARCH STARTER
    // ========================================================

    if (isSearchStarter(trimmed)) {
      setSearchSession(userId);

      return res.json({
        answer: [
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

      const documents =
        await searchDocuments(
          trimmed,
          req.user
        );

      return res.json({
        answer: buildSearchAnswer(
          trimmed,
          documents
        ),

        links:
          buildDocumentLinks(
            documents
          ),

        results:
          documents.map((doc) => ({
            id: doc.id,
            judul: doc.judul,
            nomor: doc.nomor_dokumen,
            status: doc.status,
            uploader: doc.uploader,
          })),
      });
    }

    // ========================================================
    // 3. EXPLICIT DOCUMENT SEARCH
    // ========================================================

    if (
      isExplicitDocumentSearch(trimmed)
    ) {
      const query =
        extractSearchQuery(trimmed);

      if (!query) {
        setSearchSession(userId);

        return res.json({
          answer:
            "Silakan masukkan judul, nomor dokumen, atau kata kunci dokumen yang ingin dicari.",

          links: [],

          mode: "document_search",
        });
      }

      const documents =
        await searchDocuments(
          query,
          req.user
        );

      return res.json({
        answer:
          buildSearchAnswer(
            query,
            documents
          ),

        links:
          buildDocumentLinks(
            documents
          ),

        results:
          documents.map((doc) => ({
            id: doc.id,
            judul: doc.judul,
            nomor: doc.nomor_dokumen,
            status: doc.status,
            uploader: doc.uploader,
          })),
      });
    }

    // ========================================================
    // 4. STATISTICS
    //
    // TIDAK memanggil Gemini.
    // Data langsung dari database.
    // Tetap menghasilkan tombol Dashboard.
    // ========================================================

    if (
      isStatisticsIntent(trimmed)
    ) {
      const stats =
        await getStatistics(
          req.user
        );

      return res.json({
        answer:
          buildStatisticsAnswer(
            stats
          ),

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
    // 5. HELP
    //
    // TIDAK memanggil Gemini agar format selalu konsisten.
    // ========================================================

    if (
      isHelpIntent(trimmed)
    ) {
      return res.json({
        answer:
          buildHelpAnswer(
            req.user
          ),

        links:
          buildHelpLinks(
            req.user
          ),
      });
    }

    // ========================================================
    // 6. NAVIGATION
    //
    // INI MEMPERTAHANKAN BEHAVIOR SCREENSHOT LAMA.
    //
    // "antar saya ke upload"
    // -> answer
    // -> tombol "Buka halaman Upload"
    //
    // "antar ke log"
    // -> answer
    // -> tombol "Buka Log Aktivitas"
    // ========================================================

    const navigationResponse =
      getNavigationResponse(trimmed);

    if (navigationResponse) {
      return res.json(
        navigationResponse
      );
    }

    // ========================================================
    // 7. GENERAL AI -> GEMINI
    //
    // HANYA sampai sini Gemini dipanggil.
    // ========================================================

    if (
      isGeminiRateLimited(userId)
    ) {
      return res.json({
        answer:
          "Permintaan AI sebelumnya masih diproses. Silakan coba lagi sebentar.",

        links: [],
      });
    }

    markGeminiRequest(userId);

    const cacheKey = [
      req.user?.id || "",
      req.user?.role ||
        req.user?.role_name ||
        "",
      normalizeText(trimmed),
    ].join(":");

    const cached =
      getCached(cacheKey);

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
        "Saya belum dapat memproses pertanyaan tersebut.",

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
        role:
          req.user?.role ||
          req.user?.role_name,
      }
    );

    return res.status(502).json({
      error:
        friendlyError(error),
    });
  }
}

module.exports = {
  handleChat,
};