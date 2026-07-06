/**
 * chatIntent.js
 *
 * Intent detection + route mapping untuk SAKURA AI Chatbot.
 *
 * Sebelumnya, keputusan "tampilkan tombol navigasi atau tidak" sepenuhnya
 * diserahkan ke Gemini lewat instruksi JSON bebas ("links":[...]). Ini tidak
 * konsisten — AI kadang menyertakan tombol navigasi walau user hanya
 * bertanya statistik/jumlah dokumen (informational question).
 *
 * Modul ini memindahkan keputusan itu ke logika deterministik berbasis
 * PERTANYAAN USER (bukan jawaban AI), supaya hasilnya bisa diprediksi dan
 * diaudit. Tidak menyentuh Gemini API / OCR sama sekali.
 *
 * Intent dibagi 3:
 * - "information" → JANGAN tampilkan tombol navigasi (kecuali diminta).
 * - "navigation"  → user eksplisit minta pindah/buka halaman tertentu.
 * - "folder"      → user menyebut nama folder dokumen tertentu.
 */

// ─── ROUTE MAP — halaman umum (bukan folder dokumen) ───────────────────────
const ROUTE_MAP = {
  upload:      { keys: ["upload", "unggah dokumen", "halaman upload"], path: "/upload",     label: "Buka halaman Upload" },
  dashboard:   { keys: ["dashboard", "beranda utama"],                 path: "/dashboard",   label: "Buka Dashboard" },
  approval:    { keys: ["approval", "persetujuan"],                   path: "/approval",    label: "Buka halaman Persetujuan" },
  arsip:       { keys: ["arsip", "archive"],                          path: "/archive",     label: "Buka Arsip Dokumen" },
  users:       { keys: ["manajemen pengguna", "kelola pengguna", "users", "pengguna"], path: "/users",  label: "Buka Manajemen Pengguna" },
  roles:       { keys: ["manajemen peran", "roles", "peran"],         path: "/roles",       label: "Buka Manajemen Peran" },
  logs:        { keys: ["log aktivitas", "riwayat", "logs"],          path: "/logs",        label: "Buka Log Aktivitas" },
  settings:    { keys: ["settings", "pengaturan"],                    path: "/settings",    label: "Buka Pengaturan" },
  profile:     { keys: ["profil", "profile"],                         path: "/profile",     label: "Buka Profil" },
  home:        { keys: ["home", "beranda"],                           path: "/home",        label: "Buka Beranda" },
};

// ─── FOLDER MAP — folder dokumen spesifik ───────────────────────────────────
const FOLDER_MAP = {
  "data siswa":     { path: "/documents?folder=data-siswa",     label: "Buka Folder Data Siswa" },
  "data guru":      { path: "/documents?folder=data-guru",      label: "Buka Folder Data Guru" },
  "surat masuk":    { path: "/documents?folder=surat-masuk",    label: "Buka Folder Surat Masuk" },
  "surat keluar":   { path: "/documents?folder=surat-keluar",   label: "Buka Folder Surat Keluar" },
  "arsip akademik": { path: "/documents?folder=arsip-akademik", label: "Buka Folder Arsip Akademik" },
};

// ─── Pola kata kunci ────────────────────────────────────────────────────────
// INFORMATION: pertanyaan seputar jumlah/statistik/status — TIDAK butuh tombol.
const INFO_PATTERN = /(berapa|jumlah|total|statistik|status\s+dokumen|ada\s+berapa|sudah\s+ada\s+berapa)/i;

// NAVIGATION: kata kerja yang menandakan user ingin BERPINDAH halaman.
const NAV_VERB_PATTERN = /(buka|bawa\s+saya|antar(kan)?\s+saya|pergi\s+ke|arahkan(\s+saya)?|tampilkan|menuju|pindah\s+ke|masuk\s+ke\s+halaman|ke\s+halaman)/i;

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

function findFolderMatch(lower) {
  return Object.keys(FOLDER_MAP).find((key) => lower.includes(key)) || null;
}

function findRouteMatch(lower) {
  return Object.keys(ROUTE_MAP).find((key) => ROUTE_MAP[key].keys.some((k) => lower.includes(k))) || null;
}

/**
 * Klasifikasikan intent dari pesan USER (bukan jawaban AI).
 * @param {string} message - pesan asli dari user
 * @returns {{ type: "information"|"navigation"|"folder", link?: {label:string, path:string} }}
 */
function classifyIntent(message) {
  const lower = normalize(message);
  if (!lower) return { type: "information" };

  const hasInfoPattern = INFO_PATTERN.test(lower);
  const hasNavVerb     = NAV_VERB_PATTERN.test(lower);

  // Rule utama: pertanyaan informasi ("ada berapa dokumen di folder data
  // siswa?") menang atas penyebutan folder/route selama tidak ada kata kerja
  // navigasi eksplisit. Ini yang mencegah tombol muncul hanya karena user
  // menyebut nama folder di dalam pertanyaan statistik.
  if (hasInfoPattern && !hasNavVerb) {
    return { type: "information" };
  }

  // FOLDER INTENT: user menyebut folder dokumen tertentu (dengan atau tanpa
  // kata kerja navigasi eksplisit — mis. "tampilkan data siswa" atau cukup
  // "data siswa").
  const folderKey = findFolderMatch(lower);
  if (folderKey) {
    return { type: "folder", folder: folderKey, link: FOLDER_MAP[folderKey] };
  }

  // NAVIGATION INTENT: butuh kata kerja navigasi eksplisit + halaman dikenali.
  const routeKey = findRouteMatch(lower);
  if (routeKey && hasNavVerb) {
    return { type: "navigation", route: routeKey, link: ROUTE_MAP[routeKey] };
  }

  // Default aman: tidak menampilkan tombol jika intent tidak jelas.
  return { type: "information" };
}

module.exports = { ROUTE_MAP, FOLDER_MAP, classifyIntent };