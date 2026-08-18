// Intent detector untuk navigasi SAKURA AI
const ROUTE_MAP = {
  upload: { keys: ["upload", "upload dokumen", "unggah", "unggah dokumen", "halaman upload"], path: "/upload", label: "Buka halaman Upload" },
  dashboard: { keys: ["dashboard", "beranda utama", "grafik statistik", "grafik dokumen"], path: "/dashboard", label: "Buka Dashboard" },
  approval: { keys: ["approval", "persetujuan", "halaman persetujuan"], path: "/approval", label: "Buka halaman Persetujuan" },
  archive: { keys: ["arsip", "archive", "arsip dokumen", "halaman arsip"], path: "/archive", label: "Buka halaman Arsip" },
  users: { keys: ["pengguna", "users", "manajemen pengguna", "kelola pengguna"], path: "/users", label: "Buka Manajemen Pengguna" },
  roles: { keys: ["role", "roles", "peran", "manajemen peran", "kelola peran"], path: "/roles", label: "Buka Manajemen Peran" },
  logs: { keys: ["log", "logs", "log aktivitas", "activity log", "riwayat aktivitas", "audit trail"], path: "/logs", label: "Buka Log Aktivitas" },
  settings: { keys: ["pengaturan", "settings", "setting"], path: "/settings", label: "Buka Pengaturan" },
  profile: { keys: ["profil", "profile"], path: "/profile", label: "Buka Profil" },
  home: { keys: ["home", "beranda"], path: "/home", label: "Buka Beranda" },
  trash: { keys: ["sampah", "trash", "kotak sampah"], path: "/trash", label: "Buka Kotak Sampah" },
  login: { keys: ["login", "log in", "masuk akun", "halaman login"], path: "/login", label: "Buka halaman Login" },
};

const FOLDER_MAP = {
  "data siswa": { path: "/documents?folder=data-siswa", label: "Buka Folder Data Siswa" },
  "data guru": { path: "/documents?folder=data-guru", label: "Buka Folder Data Guru" },
  "surat masuk": { path: "/documents?folder=surat-masuk", label: "Buka Folder Surat Masuk" },
  "surat keluar": { path: "/documents?folder=surat-keluar", label: "Buka Folder Surat Keluar" },
  "arsip akademik": { path: "/documents?folder=arsip-akademik", label: "Buka Folder Arsip Akademik" },
};

function normalize(text = "") {
  return String(text).toLowerCase().trim().replace(/\s+/g, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(text, keyword) {
  if (!text || !keyword) return false;
  const normalizedText = normalize(text);
  const normalizedKeyword = normalize(keyword);
  if (/^[a-z0-9]+$/i.test(normalizedKeyword)) {
    const regex = new RegExp(`\\b${escapeRegex(normalizedKeyword)}\\b`, "i");
    return regex.test(normalizedText);
  }
  return normalizedText.includes(normalizedKeyword);
}

function findRouteMatch(lower) {
  for (const [routeKey, config] of Object.entries(ROUTE_MAP)) {
    const matched = config.keys.some((keyword) => containsKeyword(lower, keyword));
    if (matched) return { routeKey, config };
  }
  return null;
}

function findFolderMatch(lower) {
  for (const [folderKey, config] of Object.entries(FOLDER_MAP)) {
    if (containsKeyword(lower, folderKey)) return { folderKey, config };
  }
  return null;
}

function hasNavigationVerb(lower) {
  if (!lower) return false;
  return /\b(buka|bukakan|antar|antarkan|bawa|bawakan|arahkan|pergi|pindah|masuk|menuju|navigasi)\b/i.test(lower);
}

function isInformationQuestion(lower) {
  if (!lower) return false;
  return (
    /\b(berapa|jumlah|total|status)\b/i.test(lower) ||
    /\b(statistik|statistic|stats)\b/i.test(lower) ||
    /ada\s+berapa/i.test(lower) ||
    /ringkasan\s+dokumen/i.test(lower)
  );
}

function classifyIntent(message) {
  const lower = normalize(message);
  if (!lower) return { type: "information" };
  const navigationRequested = hasNavigationVerb(lower);

  if (navigationRequested) {
    const folderMatch = findFolderMatch(lower);
    if (folderMatch) {
      return { type: "folder", folder: folderMatch.folderKey, link: { label: folderMatch.config.label, path: folderMatch.config.path } };
    }
  }

  if (navigationRequested) {
    const routeMatch = findRouteMatch(lower);
    if (routeMatch) {
      return { type: "navigation", route: routeMatch.routeKey, link: { label: routeMatch.config.label, path: routeMatch.config.path } };
    }
  }

  if (isInformationQuestion(lower)) return { type: "information" };
  return { type: "information" };
}

module.exports = { ROUTE_MAP, FOLDER_MAP, classifyIntent };
