const { classifyIntent } = require("../utils/chatIntent");
const { askGemini } = require("../services/geminiService");

// Sesuaikan path db jika project kamu memakai nama file berbeda.
const db = require("../config/db");

/**
 * Normalisasi text.
 */
function normalize(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Escape LIKE search.
 */
function makeSearchTerm(value = "") {
  return `%${String(value).trim()}%`;
}

/**
 * Mengambil hasil query dengan aman.
 * Mendukung mysql2/promise:
 *
 * const [rows] = await db.query(...)
 */
async function queryRows(sql, params = []) {
  const result = await db.query(sql, params);

  if (Array.isArray(result)) {
    // mysql2/promise -> [rows, fields]
    if (Array.isArray(result[0])) {
      return result[0];
    }

    return result;
  }

  return result?.rows || [];
}

/**
 * Response helper.
 *
 * Frontend tetap menerima format:
 * {
 *   reply,
 *   links,
 *   documents,
 *   type
 * }
 */
function sendReply(res, {
  reply,
  type = "text",
  links = [],
  documents = [],
  data = null,
}) {
  return res.json({
    reply,
    type,
    links,
    documents,
    data,
  });
}

/* ============================================================
 * INTENT DETECTION
 * ============================================================
 */

function isStatisticsIntent(message) {
  const lower = normalize(message);

  return (
    /\b(statistik|statistic|stats)\b/i.test(lower) ||
    /tampilkan\s+statistik/i.test(lower) ||
    /lihat\s+statistik/i.test(lower) ||
    /ringkasan\s+dokumen/i.test(lower)
  );
}

function isHelpIntent(message) {
  const lower = normalize(message);

  return (
    /bagaimana\s+cara\s+menggunakan\s+sakura/i.test(lower) ||
    /cara\s+menggunakan\s+sakura/i.test(lower) ||
    /cara\s+pakai\s+sakura/i.test(lower) ||
    /bantuan\s+penggunaan/i.test(lower) ||
    /panduan\s+sakura/i.test(lower) ||
    /fitur\s+sakura/i.test(lower)
  );
}

function isSearchIntent(message) {
  const lower = normalize(message);

  return (
    /cari\s+dokumen/i.test(lower) ||
    /carikan\s+dokumen/i.test(lower) ||
    /cari\s+arsip/i.test(lower) ||
    /temukan\s+dokumen/i.test(lower) ||
    /dokumen\s+bernama/i.test(lower) ||
    /detail\s+dokumen/i.test(lower) ||
    /^ada\s+.+\s+(ga|gak|nggak|tidak|kah)$/i.test(lower) ||
    /\b(ijazah|sertifikat|surat|buku induk|skl|transkrip)\b/i.test(lower)
  );
}

/**
 * Ambil keyword pencarian dari pesan.
 *
 * Contoh:
 *
 * "cari dokumen Ijazah Iqbal Fachrozi"
 * -> "Ijazah Iqbal Fachrozi"
 *
 * "carikan Ijazah Iqbal Fachrozi"
 * -> "Ijazah Iqbal Fachrozi"
 */
function extractSearchKeyword(message) {
  let keyword = String(message || "").trim();

  const patterns = [
    /^tolong\s+/i,
    /^saya\s+ingin\s+/i,
    /^aku\s+mau\s+/i,

    /^ada\s+/i,

    /^cari\s+dokumen\s+/i,
    /^carikan\s+dokumen\s+/i,
    /^carikan\s+/i,
    /^cari\s+arsip\s+/i,
    /^cari\s+/i,

    /^temukan\s+dokumen\s+/i,
    /^temukan\s+/i,

    /^dokumen\s+bernama\s+/i,
    /^detail\s+dokumen\s+/i,
  ];

  let changed = true;

  while (changed) {
    changed = false;

    for (const pattern of patterns) {
      const updated = keyword.replace(pattern, "").trim();

      if (updated !== keyword) {
        keyword = updated;
        changed = true;
      }
    }
  }

  return keyword
    .replace(/\s+(ga|gak|nggak|tidak|kah)\s*[?.!]*$/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();
}

/* ============================================================
 * NAVIGATION
 * ============================================================
 */

function buildNavigationReply(intent) {
  const label =
    intent?.link?.label ||
    "Buka halaman";

  const routeName =
    intent?.route ||
    intent?.folder ||
    "";

  const readableNames = {
    upload: "Upload",
    dashboard: "Dashboard",
    approval: "Persetujuan",
    archive: "Arsip",
    users: "Manajemen Pengguna",
    roles: "Manajemen Peran",
    logs: "Log Aktivitas",
    settings: "Pengaturan",
    profile: "Profil",
    home: "Beranda",
    trash: "Kotak Sampah",

    "data siswa": "Data Siswa",
    "data guru": "Data Guru",
    "surat masuk": "Surat Masuk",
    "surat keluar": "Surat Keluar",
    "arsip akademik": "Arsip Akademik",
  };

  const destination =
    readableNames[routeName] ||
    label.replace(/^Buka\s+/i, "");

  return {
    reply: `Tentu. Kamu bisa membuka ${destination} melalui tombol di bawah ini.`,
    links: [
      {
        label: intent.link.label,
        path: intent.link.path,
      },
    ],
  };
}

/* ============================================================
 * STATISTICS
 * ============================================================
 */

async function getStatistics() {
  /*
   * Kita ambil seluruh dokumen non-trash supaya statistik chatbot
   * berasal dari database, BUKAN Gemini.
   *
   * Jika nama tabel kamu "documents", query ini langsung cocok.
   */

  const rows = await queryRows(`
    SELECT *
    FROM documents
    WHERE
      deleted_at IS NULL
      OR deleted_at = ''
  `);

  const stats = {
    total: rows.length,
    waiting: 0,
    archived: 0,
    rejected: 0,
    approved: 0,
  };

  for (const doc of rows) {
    const status = normalize(
      doc.status ||
      doc.status_dokumen ||
      doc.approval_status ||
      ""
    );

    if (
      status.includes("menunggu") ||
      status.includes("pending")
    ) {
      stats.waiting += 1;
    }

    if (
      status.includes("diarsipkan") ||
      status.includes("archived") ||
      status === "arsip"
    ) {
      stats.archived += 1;
    }

    if (
      status.includes("ditolak") ||
      status.includes("rejected")
    ) {
      stats.rejected += 1;
    }

    if (
      status.includes("disetujui") ||
      status.includes("approved")
    ) {
      stats.approved += 1;
    }
  }

  return stats;
}

async function handleStatistics(res) {
  try {
    const stats = await getStatistics();

    const reply = [
      "Berikut ringkasan dokumen SAKURA saat ini:",
      "",
      `• Total dokumen: ${stats.total}`,
      `• Menunggu persetujuan: ${stats.waiting}`,
      `• Diarsipkan: ${stats.archived}`,
      `• Ditolak: ${stats.rejected}`,
      "",
      "Untuk melihat grafik dan statistik yang lebih lengkap, buka Dashboard.",
    ].join("\n");

    return sendReply(res, {
      reply,
      type: "statistics",

      data: {
        statistics: stats,
      },

      links: [
        {
          label: "Buka Dashboard",
          path: "/dashboard",
        },
      ],
    });
  } catch (error) {
    console.error(
      "[CHATBOT STATISTICS ERROR]",
      error
    );

    /*
     * Kalau struktur kolom deleted_at berbeda,
     * fallback query sederhana.
     */

    try {
      const rows = await queryRows(`
        SELECT *
        FROM documents
      `);

      const total = rows.length;

      return sendReply(res, {
        reply:
          `Saat ini terdapat ${total} dokumen yang tercatat di SAKURA.\n\n` +
          "Untuk melihat statistik dan grafik dokumen secara lengkap, buka Dashboard.",

        type: "statistics",

        links: [
          {
            label: "Buka Dashboard",
            path: "/dashboard",
          },
        ],
      });
    } catch (fallbackError) {
      console.error(
        "[CHATBOT STATISTICS FALLBACK ERROR]",
        fallbackError
      );

      return sendReply(res, {
        reply:
          "Statistik dokumen belum dapat dimuat saat ini. Kamu tetap dapat melihat data statistik melalui Dashboard.",

        type: "statistics",

        links: [
          {
            label: "Buka Dashboard",
            path: "/dashboard",
          },
        ],
      });
    }
  }
}

/* ============================================================
 * HELP / CARA MENGGUNAKAN SAKURA
 * ============================================================
 */

function handleHelp(res) {
  const reply = [
    "SAKURA digunakan untuk mengelola arsip dokumen sekolah secara digital.",
    "",
    "Menu utama yang dapat digunakan:",
    "",
    "• Dashboard — melihat ringkasan dan statistik dokumen.",
    "• Upload — menambahkan dokumen baru.",
    "• Persetujuan — memeriksa dokumen yang membutuhkan persetujuan.",
    "• Arsip — mencari dan melihat dokumen yang tersimpan.",
    "• Sampah — memulihkan atau menghapus permanen dokumen.",
    "",
    "Pilih halaman yang ingin dibuka melalui tombol di bawah ini.",
  ].join("\n");

  return sendReply(res, {
    reply,
    type: "help",

    links: [
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
      {
        label: "Buka halaman Persetujuan",
        path: "/approval",
      },
    ],
  });
}

/* ============================================================
 * DOCUMENT SEARCH
 * ============================================================
 */

async function searchDocuments(keyword) {
  if (!keyword) {
    return [];
  }

  const search = makeSearchTerm(keyword);

  /*
   * PENTING:
   *
   * TIDAK ADA FILTER status = "Diarsipkan".
   *
   * Jadi dokumen:
   * - Diarsipkan
   * - Ditolak
   * - Menunggu
   * - Disetujui
   *
   * semuanya tetap dapat ditemukan.
   */

  try {
    return await queryRows(
      `
      SELECT *
      FROM documents
      WHERE
        judul LIKE ?
        OR nomor_dokumen LIKE ?
      ORDER BY created_at DESC
      LIMIT 10
      `,
      [
        search,
        search,
      ]
    );
  } catch (error) {
    console.error(
      "[CHATBOT SEARCH PRIMARY ERROR]",
      error
    );

    /*
     * Fallback jika schema memakai camelCase.
     */
    try {
      return await queryRows(
        `
        SELECT *
        FROM documents
        WHERE
          judul LIKE ?
          OR nomorDokumen LIKE ?
        LIMIT 10
        `,
        [
          search,
          search,
        ]
      );
    } catch (fallbackError) {
      console.error(
        "[CHATBOT SEARCH FALLBACK ERROR]",
        fallbackError
      );

      /*
       * Fallback terakhir: ambil semua lalu filter JS.
       */
      const rows = await queryRows(`
        SELECT *
        FROM documents
      `);

      const normalizedKeyword =
        normalize(keyword);

      return rows
        .filter((doc) => {
          const searchable = [
            doc.judul,
            doc.nomor_dokumen,
            doc.nomorDokumen,
            doc.kategori,
            doc.category,
            doc.status,
            doc.status_dokumen,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return searchable.includes(
            normalizedKeyword
          );
        })
        .slice(0, 10);
    }
  }
}

function mapDocument(doc) {
  return {
    id:
      doc.id ||
      doc.document_id,

    title:
      doc.judul ||
      doc.title ||
      "Dokumen",

    judul:
      doc.judul ||
      doc.title ||
      "Dokumen",

    number:
      doc.nomor_dokumen ||
      doc.nomorDokumen ||
      doc.document_number ||
      "-",

    nomorDokumen:
      doc.nomor_dokumen ||
      doc.nomorDokumen ||
      doc.document_number ||
      "-",

    status:
      doc.status ||
      doc.status_dokumen ||
      doc.approval_status ||
      "-",

    category:
      doc.kategori ||
      doc.category ||
      doc.nama_kategori ||
      "-",

    kategori:
      doc.kategori ||
      doc.category ||
      doc.nama_kategori ||
      "-",

    path: "/archive",

    link: {
      label: "Buka arsip",
      path: "/archive",
    },
  };
}

async function handleDocumentSearch(
  res,
  message
) {
  const keyword =
    extractSearchKeyword(message);

  if (!keyword) {
    return sendReply(res, {
      reply:
        "Silakan masukkan judul atau nomor dokumen yang ingin dicari.",

      type: "search",

      links: [
        {
          label: "Buka halaman Arsip",
          path: "/archive",
        },
      ],
    });
  }

  try {
    const rows =
      await searchDocuments(keyword);

    if (!rows.length) {
      return sendReply(res, {
        reply:
          `Tidak ditemukan dokumen "${keyword}" yang sesuai dengan pencarian tersebut.\n\n` +
          "Kamu dapat mencoba judul, nomor dokumen, atau kata kunci lain.",

        type: "search",

        links: [
          {
            label: "Buka halaman Arsip",
            path: "/archive",
          },
        ],
      });
    }

    const documents =
      rows.map(mapDocument);

    /*
     * Kalau hanya satu hasil:
     * tampilkan detail seperti UI lama.
     */

    if (documents.length === 1) {
      const doc = documents[0];

      return sendReply(res, {
        reply:
          `Ada. Saya menemukan dokumen ${doc.judul}.\n\nNomor: ${doc.nomorDokumen}\nStatus: ${doc.status}${doc.kategori && doc.kategori !== "-" ? `\nKategori: ${doc.kategori}` : ""}`,

        type: "document_detail",

        documents: [
          doc,
        ],

        links: [
          {
            label: `Buka dokumen: ${doc.judul}`,
            path: "/archive",
          },
        ],
      });
    }

    /*
     * Kalau ada beberapa dokumen dengan judul sama,
     * SEMUANYA dikembalikan.
     *
     * Ini penting untuk kasus:
     * "Ijazah Iqbal Fachrozi"
     *
     * yang mungkin punya:
     * - satu Diarsipkan
     * - satu Ditolak
     * - status lainnya
     */

    const summary =
      documents
        .slice(0, 5)
        .map((doc) => {
          return (
            `• ${doc.judul}\n` +
            `  ${doc.nomorDokumen} — ${doc.status}`
          );
        })
        .join("\n");

    return sendReply(res, {
      reply:
        `Ditemukan ${documents.length} dokumen yang cocok dengan "${keyword}":\n\n` +
        summary,

      type: "document_results",

      documents,

      links: documents
        .slice(0, 5)
        .map((doc) => ({
          label:
            `Buka dokumen: ${doc.judul}`,
          path: "/archive",
        })),
    });
  } catch (error) {
    console.error(
      "[CHATBOT DOCUMENT SEARCH ERROR]",
      error
    );

    return sendReply(res, {
      reply:
        "Pencarian dokumen belum dapat diproses saat ini. Kamu dapat membuka halaman Arsip untuk melakukan pencarian langsung.",

      type: "search",

      links: [
        {
          label: "Buka halaman Arsip",
          path: "/archive",
        },
      ],
    });
  }
}

/* ============================================================
 * GEMINI FALLBACK
 * ============================================================
 */

async function handleGeminiFallback(
  res,
  message,
  history = []
) {
  try {
    /*
     * Gemini HANYA digunakan untuk percakapan bebas.
     *
     * Statistik, search, bantuan, dan navigasi
     * tidak melewati Gemini.
     */

    const systemPrompt = `Kamu adalah SAKURA AI Assistant untuk sistem manajemen arsip digital SMP Negeri 4 Cikarang Barat.
Jawab dalam Bahasa Indonesia yang singkat, natural, rapi, dan mudah dibaca di chatbot kecil.
Kamu memahami fitur SAKURA: Dashboard, Upload Dokumen, Scan Dokumen, Arsip, Persetujuan, Pengguna, Role, Log Aktivitas, Notifikasi, Kotak Sampah, Profil, dan Pengaturan.
Jangan mengarang data dokumen atau statistik. Jangan memberikan kredensial atau informasi teknis sensitif.
Jika pertanyaan berkaitan dengan cara menggunakan SAKURA, jelaskan berdasarkan fitur-fitur tersebut dan jangan mengatakan bahwa kamu tidak tahu.`;

    const historyText = Array.isArray(history)
      ? history.slice(-6).map((item) => `${item?.role === "assistant" ? "Assistant" : "User"}: ${String(item?.content || "")}`).join("\n")
      : "";

    const userMessage = historyText
      ? `${historyText}\nUser: ${message}`
      : message;

    const result = await askGemini(
      systemPrompt,
      userMessage
    );

    let reply = "";

    if (typeof result === "string") {
      reply = result;
    } else {
      reply =
        result?.reply ||
        result?.text ||
        result?.response ||
        "";
    }

    if (!reply) {
      reply =
        "Saya siap membantu seputar penggunaan sistem SAKURA.";
    }

    return sendReply(res, {
      reply,
      type: "ai",
    });
  } catch (error) {
    console.error(
      "[CHATBOT GEMINI ERROR]",
      error
    );

    /*
     * Gemini 429 tidak boleh membuat seluruh chatbot mati.
     */
    if (
      error?.status === 429 ||
      error?.response?.status === 429 ||
      String(error?.message || "")
        .toLowerCase()
        .includes("429") ||
      String(error?.message || "")
        .toLowerCase()
        .includes("quota") ||
      String(error?.message || "")
        .toLowerCase()
        .includes("too many")
    ) {
      return sendReply(res, {
        reply:
          "Layanan AI sedang sibuk. Fitur pencarian dokumen, statistik, bantuan, dan navigasi SAKURA tetap dapat digunakan.",

        type: "ai_error",
      });
    }

    return sendReply(res, {
      reply:
        "Saya belum dapat memproses pertanyaan tersebut saat ini. Kamu masih dapat menggunakan pencarian dokumen, statistik, bantuan, dan navigasi SAKURA.",

      type: "ai_error",
    });
  }
}

/* ============================================================
 * CONTEXTUAL FOLLOW-UP NAVIGATION
 * ============================================================
 *
 * Hanya menangani referensi ke konteks sebelumnya, misalnya:
 * - "coba antar aku ke sana"
 * - "buka itu"
 * - "antar ke situ"
 * - "buka yang tadi"
 *
 * Tidak mengubah intent navigasi biasa.
 */
function isContextualNavigationRequest(message) {
  const lower = normalize(message);

  const hasNavVerb =
    /\b(buka|bukakan|antar|antarkan|bawa|bawakan|arahkan|pergi|pindah|masuk|menuju|navigasi)\b/i.test(lower);

  const hasContextReference =
    /\b(sana|situ|itu|tadi|yang tadi|dokumen tadi|dokumen itu|halaman tadi|halaman itu)\b/i.test(lower);

  return hasNavVerb && hasContextReference;
}

function getLastContextLink(history = []) {
  if (!Array.isArray(history)) {
    return null;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];

    if (!item || item.role !== "assistant") {
      continue;
    }

    const links = Array.isArray(item.links)
      ? item.links
      : item.link
      ? [item.link]
      : [];

    const validLink = links.find(
      (link) => link && link.path
    );

    if (validLink) {
      return {
        label:
          validLink.label ||
          "Buka halaman",
        path:
          validLink.path,
      };
    }
  }

  return null;
}

/* ============================================================
 * MAIN CHAT HANDLER
 * ============================================================
 */

async function handleChat(req, res) {
  try {
    const {
      message,
      history = [],
    } = req.body || {};

    if (
      !message ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      return res.status(400).json({
        error:
          "Pesan tidak boleh kosong.",
      });
    }

    const cleanMessage =
      message.trim();

    /*
     * ========================================================
     * CONTEXT FOLLOW-UP — "antar aku ke sana", "buka itu", dll.
     * ========================================================
     */
    if (isContextualNavigationRequest(cleanMessage)) {
      const previousLink = getLastContextLink(history);

      if (previousLink) {
        return sendReply(res, {
          reply: "Tentu. Kamu bisa membukanya melalui tombol di bawah ini.",
          type: "navigation",
          links: [previousLink],
        });
      }
    }

    /*
     * ========================================================
     * PRIORITY 1 — STATISTICS
     * ========================================================
     *
     * "Tampilkan statistik dokumen"
     *
     * HARUS diproses database.
     * Tidak boleh kena Gemini 429.
     */

    if (
      isStatisticsIntent(cleanMessage)
    ) {
      return await handleStatistics(res);
    }

    /*
     * ========================================================
     * PRIORITY 2 — HELP
     * ========================================================
     */

    if (isHelpIntent(cleanMessage)) {
      return handleHelp(res);
    }

    /*
     * ========================================================
     * PRIORITY 3 — DOCUMENT SEARCH
     * ========================================================
     */

    if (isSearchIntent(cleanMessage)) {
      return await handleDocumentSearch(
        res,
        cleanMessage
      );
    }

    /*
     * ========================================================
     * PRIORITY 4 — NAVIGATION
     * ========================================================
     */

    const intent =
      classifyIntent(cleanMessage);

    if (
      (
        intent.type === "navigation" ||
        intent.type === "folder"
      ) &&
      intent.link
    ) {
      const navigation =
        buildNavigationReply(intent);

      return sendReply(res, {
        reply:
          navigation.reply,

        type: "navigation",

        links:
          navigation.links,
      });
    }

    /*
     * ========================================================
     * PRIORITY 5 — GEMINI
     * ========================================================
     *
     * Hanya percakapan bebas yang sampai sini.
     */

    return await handleGeminiFallback(
      res,
      cleanMessage,
      history
    );
  } catch (error) {
    console.error(
      "[CHATBOT CONTROLLER ERROR]",
      error
    );

    return res.status(500).json({
      error:
        "Chatbot tidak dapat memproses permintaan.",
    });
  }
}

module.exports = {
  handleChat,
};