// ── Date Parser/Normalizer ───────────────────────────────────────────────────
// Dipakai untuk menormalisasi tanggal hasil OCR (atau input manual) yang bisa
// datang dalam berbagai format ("17 Januari 1999", "17/01/1999", dst) menjadi
// format ISO "YYYY-MM-DD" sebelum disimpan ke database (kolom DATE).
//
// PENTING: modul ini TIDAK menyentuh proses OCR itu sendiri (lihat
// services/geminiService.js) — hasil mentah OCR tetap apa adanya. Modul ini
// hanya dipakai sesaat sebelum INSERT ke database untuk mem-validasi dan
// menormalisasi nilai tanggal.

const MONTH_MAP = {
  // Indonesia (nama penuh & singkatan umum)
  jan: 1, januari: 1,
  feb: 2, februari: 2,
  mar: 3, maret: 3,
  apr: 4, april: 4,
  mei: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  agu: 8, ags: 8, agt: 8, agustus: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10,
  nov: 11, november: 11,
  des: 12, desember: 12,
  // English (nama penuh & singkatan umum)
  january: 1,
  february: 2,
  march: 3,
  june: 6,
  july: 7,
  august: 8,
  october: 10,
  december: 12,
  // "may"/"mei" ambigu antara Indonesia & Inggris, tapi sama-sama bulan 5.
  may: 5,
  // "jun"/"jul" sudah sama antara Indonesia & Inggris di atas.
  aug: 8,
  oct: 10,
  dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isValidDate(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (y < 1000 || y > 9999) return false;
  if (mo < 1 || mo > 12) return false;
  const daysInMonth = new Date(y, mo, 0).getDate();
  if (d < 1 || d > daysInMonth) return false;
  return true;
}

function toISO(y, mo, d) {
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * Normalisasi berbagai format tanggal menjadi "YYYY-MM-DD".
 * Mendukung antara lain:
 *   17 Januari 1999 | 17 Jan 1999 | 17-01-1999 | 17/01/1999 |
 *   1999-01-17 | 17.01.1999 | 17 January 1999 | January 17, 1999 |
 *   17 Januari,1999
 *
 * @param {string|null|undefined} raw
 * @returns {{ value: string|null, error: string|null }}
 *   value: tanggal ISO (YYYY-MM-DD) atau null jika input kosong.
 *   error: pesan error yang jelas jika format tidak bisa dikenali, atau null.
 */
function normalizeDateToISO(raw) {
  if (raw === null || raw === undefined) return { value: null, error: null };

  const original = String(raw).trim();
  if (original === "") return { value: null, error: null };

  const fail = () => ({
    value: null,
    error:
      `Format tanggal "${original}" tidak dikenali. Gunakan salah satu format ` +
      `berikut: 17 Januari 1999, 17 Jan 1999, 17-01-1999, 17/01/1999, ` +
      `1999-01-17, 17.01.1999, 17 January 1999, January 17, 1999.`,
  });

  // Bersihkan koma & rapikan spasi supaya "17 Januari,1999" ≈ "17 Januari 1999".
  const cleaned = original.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  let match;

  // 1) ISO: YYYY-MM-DD (atau YYYY/M/D dsb — jarang, tapi ditangani juga)
  match = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    const y = Number(match[1]);
    const mo = Number(match[2]);
    const d = Number(match[3]);
    return isValidDate(y, mo, d) ? { value: toISO(y, mo, d), error: null } : fail();
  }

  // 2) D-M-YYYY / D/M/YYYY / D.M.YYYY (konvensi Indonesia: tanggal/bulan/tahun)
  match = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const d = Number(match[1]);
    const mo = Number(match[2]);
    const y = Number(match[3]);
    return isValidDate(y, mo, d) ? { value: toISO(y, mo, d), error: null } : fail();
  }

  // 3) "17 Januari 1999" / "17 Jan 1999" / "17 January 1999" (Tanggal Bulan Tahun)
  match = cleaned.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (match) {
    const d = Number(match[1]);
    const mo = MONTH_MAP[match[2].toLowerCase()];
    const y = Number(match[3]);
    if (!mo) return fail();
    return isValidDate(y, mo, d) ? { value: toISO(y, mo, d), error: null } : fail();
  }

  // 4) "January 17 1999" / "January 17, 1999" (Bulan Tanggal Tahun)
  match = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2})\s+(\d{4})$/);
  if (match) {
    const mo = MONTH_MAP[match[1].toLowerCase()];
    const d = Number(match[2]);
    const y = Number(match[3]);
    if (!mo) return fail();
    return isValidDate(y, mo, d) ? { value: toISO(y, mo, d), error: null } : fail();
  }

  return fail();
}

module.exports = { normalizeDateToISO };