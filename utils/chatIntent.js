/**
 * utils/chatIntent.js
 *
 * Intent detector untuk navigasi SAKURA AI.
 *
 * Tujuan:
 * - Navigasi ditentukan secara deterministik, bukan diserahkan ke Gemini.
 * - Tetap menghasilkan tombol navigasi seperti UI chatbot sebelumnya.
 * - Pertanyaan statistik/search/help tidak salah masuk ke navigation.
 * - Mendukung perintah natural seperti:
 *   "antar saya ke upload"
 *   "antar ke log"
 *   "buka arsip"
 *   "bawa saya ke dashboard"
 */

const ROUTE_MAP = {
  upload: {
    keys: [
      "upload",
      "upload dokumen",
      "unggah",
      "unggah dokumen",
      "halaman upload",
    ],
    path: "/upload",
    label: "Buka halaman Upload",
  },

  dashboard: {
    keys: [
      "dashboard",
      "beranda utama",
      "grafik statistik",
      "grafik dokumen",
    ],
    path: "/dashboard",
    label: "Buka Dashboard",
  },

  approval: {
    keys: [
      "approval",
      "persetujuan",
      "halaman persetujuan",
    ],
    path: "/approval",
    label: "Buka halaman Persetujuan",
  },

  archive: {
    keys: [
      "arsip",
      "archive",
      "arsip dokumen",
      "halaman arsip",
    ],
    path: "/archive",
    label: "Buka halaman Arsip",
  },

  users: {
    keys: [
      "pengguna",
      "users",
      "manajemen pengguna",
      "kelola pengguna",
    ],
    path: "/users",
    label: "Buka Manajemen Pengguna",
  },

  roles: {
    keys: [
      "role",
      "roles",
      "peran",
      "manajemen peran",
      "kelola peran",
    ],
    path: "/roles",
    label: "Buka Manajemen Peran",
  },

  logs: {
    keys: [
      "log",
      "logs",
      "log aktivitas",
      "activity log",
      "riwayat aktivitas",
      "audit trail",
    ],
    path: "/logs",
    label: "Buka Log Aktivitas",
  },

  settings: {
    keys: [
      "pengaturan",
      "settings",
      "setting",
    ],
    path: "/settings",
    label: "Buka Pengaturan",
  },

  profile: {
    keys: [
      "profil",
      "profile",
    ],
    path: "/profile",
    label: "Buka Profil",
  },

  home: {
    keys: [
      "home",
      "beranda",
    ],
    path: "/home",
    label: "Buka Beranda",
  },

  trash: {
    keys: [
      "sampah",
      "trash",
      "kotak sampah",
    ],
    path: "/trash",
    label: "Buka Kotak Sampah",
  },
};

const FOLDER_MAP = {
  "data siswa": {
    path: "/documents?folder=data-siswa",
    label: "Buka Folder Data Siswa",
  },

  "data guru": {
    path: "/documents?folder=data-guru",
    label: "Buka Folder Data Guru",
  },

  "surat masuk": {
    path: "/documents?folder=surat-masuk",
    label: "Buka Folder Surat Masuk",
  },

  "surat keluar": {
    path: "/documents?folder=surat-keluar",
    label: "Buka Folder Surat Keluar",
  },

  "arsip akademik": {
    path: "/documents?folder=arsip-akademik",
    label: "Buka Folder Arsip Akademik",
  },
};

/**
 * Normalisasi teks user agar pencocokan intent lebih konsisten.
 */
function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Escape karakter khusus sebelum dimasukkan ke RegExp.
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mengecek apakah sebuah keyword terdapat dalam teks.
 *
 * Untuk keyword satu kata:
 * - menggunakan word boundary
 * - mencegah "log" salah match dengan kata lain
 *
 * Untuk keyword lebih dari satu kata:
 * - menggunakan includes()
 */
function containsKeyword(text, keyword) {
  if (!text || !keyword) {
    return false;
  }

  const normalizedText = normalize(text);
  const normalizedKeyword = normalize(keyword);

  if (/^[a-z0-9]+$/i.test(normalizedKeyword)) {
    const regex = new RegExp(
      `\\b${escapeRegex(normalizedKeyword)}\\b`,
      "i"
    );

    return regex.test(normalizedText);
  }

  return normalizedText.includes(normalizedKeyword);
}

/**
 * Cari halaman umum yang disebut user.
 */
function findRouteMatch(lower) {
  for (const [routeKey, config] of Object.entries(ROUTE_MAP)) {
    const matched = config.keys.some((keyword) =>
      containsKeyword(lower, keyword)
    );

    if (matched) {
      return {
        routeKey,
        config,
      };
    }
  }

  return null;
}

/**
 * Cari folder dokumen yang disebut user.
 */
function findFolderMatch(lower) {
  for (const [folderKey, config] of Object.entries(FOLDER_MAP)) {
    if (containsKeyword(lower, folderKey)) {
      return {
        folderKey,
        config,
      };
    }
  }

  return null;
}

/**
 * Mengecek apakah user benar-benar meminta navigasi.
 *
 * Contoh yang dikenali:
 *
 * - "antar saya ke upload"
 * - "antar ke log"
 * - "antarkan saya ke arsip"
 * - "buka dashboard"
 * - "bukakan halaman upload"
 * - "bawa saya ke log"
 * - "bawakan saya ke arsip"
 * - "arahkan saya ke persetujuan"
 * - "pergi ke profil"
 * - "pindah ke dashboard"
 * - "masuk ke pengaturan"
 * - "menuju halaman arsip"
 *
 * CATATAN:
 * Regex HARUS satu baris.
 * JavaScript tidak mendukung regex flag "x".
 */
function hasNavigationVerb(lower) {
  if (!lower) {
    return false;
  }

  return /\b(buka|bukakan|antar|antarkan|bawa|bawakan|arahkan|pergi|pindah|masuk|menuju|navigasi)\b/i.test(
    lower
  );
}

/**
 * Mengecek apakah pesan merupakan pertanyaan informasi.
 *
 * Ini penting supaya pertanyaan seperti:
 *
 * "berapa jumlah dokumen?"
 * "tampilkan statistik dokumen"
 * "berapa dokumen ditolak?"
 *
 * tidak otomatis dianggap sebagai navigasi.
 */
function isInformationQuestion(lower) {
  if (!lower) {
    return false;
  }

  return (
    /\b(berapa|jumlah|total|status)\b/i.test(lower) ||
    /\b(statistik|statistic|stats)\b/i.test(lower) ||
    /ada\s+berapa/i.test(lower) ||
    /ringkasan\s+dokumen/i.test(lower)
  );
}

/**
 * Klasifikasi intent pesan user.
 *
 * Hasil:
 *
 * {
 *   type: "navigation",
 *   route: "upload",
 *   link: {
 *     label: "Buka halaman Upload",
 *     path: "/upload"
 *   }
 * }
 *
 * atau:
 *
 * {
 *   type: "folder",
 *   folder: "data siswa",
 *   link: {...}
 * }
 *
 * atau:
 *
 * {
 *   type: "information"
 * }
 */
function classifyIntent(message) {
  const lower = normalize(message);

  if (!lower) {
    return {
      type: "information",
    };
  }

  const navigationRequested = hasNavigationVerb(lower);

  /*
   * ============================================================
   * 1. NAVIGASI FOLDER
   * ============================================================
   *
   * Contoh:
   *
   * "antar saya ke data siswa"
   * "buka folder data guru"
   * "arahkan saya ke surat masuk"
   */

  if (navigationRequested) {
    const folderMatch = findFolderMatch(lower);

    if (folderMatch) {
      return {
        type: "folder",

        folder: folderMatch.folderKey,

        link: {
          label: folderMatch.config.label,
          path: folderMatch.config.path,
        },
      };
    }
  }

  /*
   * ============================================================
   * 2. NAVIGASI HALAMAN
   * ============================================================
   *
   * Contoh:
   *
   * "antar saya ke upload"
   * "antar ke log"
   * "buka dashboard"
   * "bawa saya ke arsip"
   */

  if (navigationRequested) {
    const routeMatch = findRouteMatch(lower);

    if (routeMatch) {
      return {
        type: "navigation",

        route: routeMatch.routeKey,

        link: {
          label: routeMatch.config.label,
          path: routeMatch.config.path,
        },
      };
    }
  }

  /*
   * ============================================================
   * 3. INFORMATION
   * ============================================================
   *
   * Contoh:
   *
   * "berapa jumlah dokumen?"
   * "tampilkan statistik dokumen"
   * "berapa dokumen yang ditolak?"
   *
   * Ini TIDAK dianggap navigation di sini.
   *
   * Controller chatbot dapat menangani intent statistik secara
   * khusus dan tetap memberikan tombol Dashboard jika diperlukan.
   */

  if (isInformationQuestion(lower)) {
    return {
      type: "information",
    };
  }

  /*
   * ============================================================
   * 4. DEFAULT
   * ============================================================
   *
   * Search dokumen, bantuan penggunaan, percakapan dengan Gemini,
   * dan intent lain akan diteruskan sebagai information.
   */

  return {
    type: "information",
  };
}

module.exports = {
  ROUTE_MAP,
  FOLDER_MAP,
  classifyIntent,
};