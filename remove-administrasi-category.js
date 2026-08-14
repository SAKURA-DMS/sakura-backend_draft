/**
 * Script migrasi satu kali: hapus kategori "Administrasi" dan pindahkan
 * seluruh jenis dokumen (document_types) yang ada di bawahnya ke kategori
 * "Data Siswa" / "Data Guru" yang SUDAH ADA (bukan membuat kategori/folder
 * baru — sesuai konfirmasi user).
 *
 * Kenapa dibutuhkan:
 *  - Kategori "Administrasi" dihapus dari pilihan di halaman Upload, tapi
 *    data & dokumen lama yang sudah terlanjur pakai kategori ini TIDAK BOLEH
 *    hilang / rusak referensinya.
 *  - document_types, documents, dan folders semuanya punya kolom category_id
 *    yang menunjuk ke kategori "Administrasi" (category_id lama) — semua ini
 *    perlu dipindah ke category_id "Data Siswa"/"Data Guru" SEBELUM baris
 *    kategori "Administrasi" dihapus.
 *
 * Pemetaan jenis dokumen (sesuai konfirmasi user, boleh disesuaikan lagi
 * kalau ternyata ada nama jenis dokumen yang belum tercakup — lihat log
 * "PERLU DITINJAU MANUAL" di akhir proses):
 *   -> Data Guru : Modul Ajar, RPP, Silabus, Program Tahunan (Prota),
 *                  Program Semester (Promes), Bahan Ajar, Bank Soal,
 *                  Kisi-kisi, Rubrik Penilaian, Jurnal Mengajar,
 *                  SK Mengajar, Sertifikat Diklat, Sertifikat Seminar,
 *                  Portofolio Guru
 *   -> Data Siswa: Rekap Nilai, Absensi Siswa, Laporan Hasil Belajar,
 *                  Portofolio Siswa
 *
 * Folder di tabel `folders` TIDAK dihapus — folder yang tadinya menunjuk ke
 * kategori "Administrasi" (baik folder induk maupun sub-folder per jenis
 * dokumen) di-UPDATE in-place (category_id & parent_id-nya diarahkan ulang
 * ke folder "Data Siswa"/"Data Guru"). Ini sengaja dilakukan supaya
 * `documents.folder_id` yang sudah menunjuk ke folder tsb TETAP VALID dan
 * dokumen lama tetap bisa ditemukan di halaman Arsip, tanpa perlu mengubah
 * satu baris pun di tabel `documents.folder_id`.
 *
 * IDEMPOTENT — aman dijalankan berkali-kali:
 *   - Kalau kategori "Administrasi" sudah tidak ada lagi (sudah pernah
 *     dijalankan sebelumnya), script akan berhenti tanpa melakukan apa-apa.
 *
 * Cara pakai:
 *   cd backend
 *   node scripts/remove-administrasi-category.js
 */

require("dotenv").config();
const pool = require("../config/db");

const ADMIN_CATEGORY_NAME = "Administrasi";
const TARGET_CATEGORY_NAMES = {
  guru: "Data Guru",
  siswa: "Data Siswa",
};

// Pemetaan berdasarkan NAMA jenis dokumen (bukan type_id) supaya aman
// walaupun urutan/ID di database berbeda dari lingkungan development.
const GURU_TYPE_NAMES = [
  "Modul Ajar",
  "RPP",
  "Silabus",
  "Program Tahunan (Prota)",
  "Program Semester (Promes)",
  "Bahan Ajar",
  "Bank Soal",
  "Kisi-kisi",
  "Rubrik Penilaian",
  "Jurnal Mengajar",
  "SK Mengajar",
  "Sertifikat Diklat",
  "Sertifikat Seminar",
  "Portofolio Guru",
].map((s) => s.toLowerCase());

const SISWA_TYPE_NAMES = [
  "Rekap Nilai",
  "Absensi Siswa",
  "Laporan Hasil Belajar",
  "Portofolio Siswa",
].map((s) => s.toLowerCase());

function resolveTarget(typeName) {
  const n = typeName.trim().toLowerCase();
  if (GURU_TYPE_NAMES.includes(n)) return "guru";
  if (SISWA_TYPE_NAMES.includes(n)) return "siswa";
  return null; // tidak dikenali -> perlu ditinjau manual
}

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[adminCat]] = await conn.query(
      "SELECT category_id, category_name FROM categories WHERE LOWER(category_name) = LOWER(?)",
      [ADMIN_CATEGORY_NAME]
    );

    if (!adminCat) {
      console.log(`✓ Kategori "${ADMIN_CATEGORY_NAME}" tidak ditemukan — migrasi sudah pernah dijalankan atau memang belum ada. Tidak ada yang perlu dilakukan.`);
      await conn.rollback();
      return;
    }
    const adminCatId = adminCat.category_id;

    const [[guruCat]] = await conn.query(
      "SELECT category_id, category_name FROM categories WHERE LOWER(category_name) = LOWER(?)",
      [TARGET_CATEGORY_NAMES.guru]
    );
    const [[siswaCat]] = await conn.query(
      "SELECT category_id, category_name FROM categories WHERE LOWER(category_name) = LOWER(?)",
      [TARGET_CATEGORY_NAMES.siswa]
    );

    if (!guruCat || !siswaCat) {
      throw new Error(
        `Kategori tujuan tidak ditemukan (Data Guru: ${guruCat ? "ADA" : "TIDAK ADA"}, Data Siswa: ${siswaCat ? "ADA" : "TIDAK ADA"}). ` +
        `Migrasi dibatalkan supaya tidak salah pindah data. Pastikan kategori "Data Guru" dan "Data Siswa" sudah ada di database.`
      );
    }

    const targetCategoryId = { guru: guruCat.category_id, siswa: siswaCat.category_id };

    // Root folder (folder induk, type_id NULL, parent_id NULL) untuk masing-masing
    // kategori tujuan — dipakai untuk re-parent sub-folder eks-Administrasi.
    const [[guruRootFolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
      [targetCategoryId.guru]
    );
    const [[siswaRootFolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
      [targetCategoryId.siswa]
    );

    if (!guruRootFolder) {
      console.warn(`⚠ Folder induk untuk kategori "Data Guru" tidak ditemukan di tabel folders — sub-folder eks-Administrasi yang dipindah ke Data Guru TIDAK akan di-reparent (category_id tetap diupdate, tapi parent_id dibiarkan apa adanya).`);
    }
    if (!siswaRootFolder) {
      console.warn(`⚠ Folder induk untuk kategori "Data Siswa" tidak ditemukan di tabel folders — sub-folder eks-Administrasi yang dipindah ke Data Siswa TIDAK akan di-reparent (category_id tetap diupdate, tapi parent_id dibiarkan apa adanya).`);
    }

    // Semua document_types yang saat ini di bawah kategori Administrasi.
    const [adminTypes] = await conn.query(
      "SELECT type_id, type_name FROM document_types WHERE category_id = ?",
      [adminCatId]
    );

    if (adminTypes.length === 0) {
      console.log(`ℹ Kategori "${ADMIN_CATEGORY_NAME}" ditemukan (id=${adminCatId}) tapi tidak punya document_types. Lanjut menghapus kategori & folder induknya saja.`);
    }

    const unresolvedTypes = [];
    let movedGuru = 0;
    let movedSiswa = 0;

    for (const t of adminTypes) {
      const target = resolveTarget(t.type_name);
      if (!target) {
        unresolvedTypes.push(t);
        continue;
      }
      const newCatId = targetCategoryId[target];
      const rootFolder = target === "guru" ? guruRootFolder : siswaRootFolder;

      // 1) Pindahkan document_types.category_id
      await conn.query("UPDATE document_types SET category_id = ? WHERE type_id = ?", [newCatId, t.type_id]);

      // 2) Pindahkan documents.category_id (dokumen lama yang pakai jenis ini)
      await conn.query(
        "UPDATE documents SET category_id = ? WHERE type_id = ? AND category_id = ?",
        [newCatId, t.type_id, adminCatId]
      );

      // 3) Update in-place folder (sub-folder per jenis dokumen), kalau ada —
      //    folder_id TIDAK berubah supaya documents.folder_id yang sudah
      //    menunjuk ke folder ini tetap valid.
      if (rootFolder) {
        await conn.query(
          "UPDATE folders SET category_id = ?, parent_id = ? WHERE category_id = ? AND type_id = ?",
          [newCatId, rootFolder.folder_id, adminCatId, t.type_id]
        );
      } else {
        await conn.query(
          "UPDATE folders SET category_id = ? WHERE category_id = ? AND type_id = ?",
          [newCatId, adminCatId, t.type_id]
        );
      }

      if (target === "guru") movedGuru++; else movedSiswa++;
      console.log(`  ✓ "${t.type_name}" (type_id=${t.type_id}) -> ${target === "guru" ? "Data Guru" : "Data Siswa"}`);
    }

    if (unresolvedTypes.length > 0) {
      console.warn(`\n⚠ PERLU DITINJAU MANUAL — ${unresolvedTypes.length} jenis dokumen di kategori "Administrasi" TIDAK dikenali dalam daftar pemetaan Guru/Siswa, sehingga TIDAK dipindahkan otomatis dan kategori "Administrasi" TIDAK akan dihapus dulu supaya data ini tidak hilang:`);
      unresolvedTypes.forEach((t) => console.warn(`    - "${t.type_name}" (type_id=${t.type_id})`));
      console.warn(`\nSilakan tambahkan nama jenis dokumen di atas ke daftar GURU_TYPE_NAMES / SISWA_TYPE_NAMES pada script ini, lalu jalankan ulang.`);
      throw new Error("Ada jenis dokumen yang belum dipetakan — migrasi dibatalkan (rollback), tidak ada perubahan yang disimpan.");
    }

    // Semua document_types eks-Administrasi sudah dipindah. Sekarang aman
    // untuk membereskan sisa referensi ke kategori Administrasi:

    // Jaga-jaga: kalau masih ada documents.category_id = adminCatId yang
    // lolos dari loop di atas (mis. type_id sudah tidak match document_types
    // manapun / data tidak konsisten), pindahkan ke "Data Guru" sebagai
    // fallback aman, supaya FK/data historis tidak menunjuk ke kategori yang
    // akan dihapus.
    const [strayDocsResult] = await conn.query(
      "UPDATE documents SET category_id = ? WHERE category_id = ?",
      [targetCategoryId.guru, adminCatId]
    );
    if (strayDocsResult.affectedRows > 0) {
      console.warn(`⚠ ${strayDocsResult.affectedRows} dokumen dengan category_id Administrasi yang tidak match jenis dokumen manapun dipindahkan paksa ke "Data Guru". Mohon ditinjau manual.`);
    }

    // Folder induk (root) kategori Administrasi, kalau ada — reparent dulu
    // anak-anaknya yang tersisa (harusnya sudah 0 setelah loop di atas), lalu
    // hapus baris foldernya sendiri (folder induk tidak direferensikan
    // langsung oleh documents.folder_id di alur normal aplikasi).
    const [[adminRootFolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
      [adminCatId]
    );
    if (adminRootFolder) {
      const [remainingChildren] = await conn.query(
        "SELECT folder_id FROM folders WHERE parent_id = ?",
        [adminRootFolder.folder_id]
      );
      if (remainingChildren.length > 0) {
        // Sub-folder custom yang dibuat manual dan tidak terkait document_type
        // manapun (mis. folder custom buatan user di dalam "Administrasi").
        // Pindahkan ke folder induk "Data Guru" sebagai fallback aman.
        const fallbackParent = guruRootFolder ? guruRootFolder.folder_id : null;
        await conn.query("UPDATE folders SET category_id = ?, parent_id = ? WHERE parent_id = ?", [
          targetCategoryId.guru,
          fallbackParent,
          adminRootFolder.folder_id,
        ]);
        console.warn(`⚠ ${remainingChildren.length} sub-folder custom di bawah "Administrasi" (tidak terkait jenis dokumen baku) dipindahkan ke "Data Guru". Mohon ditinjau manual.`);
      }
      await conn.query("DELETE FROM folders WHERE folder_id = ?", [adminRootFolder.folder_id]);
      console.log(`  ✓ Folder induk "Administrasi" (folder_id=${adminRootFolder.folder_id}) dihapus.`);
    }

    // Terakhir: hapus baris kategori "Administrasi" itu sendiri.
    await conn.query("DELETE FROM categories WHERE category_id = ?", [adminCatId]);

    await conn.query(
      `INSERT INTO audit_trail (document_id, user_id, action, new_value)
       VALUES (NULL, NULL, ?, ?)`,
      [
        `Migrasi: kategori "Administrasi" dihapus, ${movedGuru} jenis dokumen dipindah ke "Data Guru" dan ${movedSiswa} ke "Data Siswa"`,
        JSON.stringify({ movedGuru, movedSiswa, adminCategoryIdRemoved: adminCatId }),
      ]
    );

    await conn.commit();

    console.log(`\n✓ Migrasi selesai.`);
    console.log(`  - ${movedGuru} jenis dokumen dipindah ke "Data Guru"`);
    console.log(`  - ${movedSiswa} jenis dokumen dipindah ke "Data Siswa"`);
    console.log(`  - Kategori "Administrasi" (category_id=${adminCatId}) dihapus dari database.`);
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error("\n✗ Migrasi gagal, semua perubahan dibatalkan (rollback):", e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();