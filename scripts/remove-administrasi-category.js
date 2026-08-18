require("dotenv").config();
const pool = require("../config/db");

const ADMIN_CATEGORY_NAME = "Administrasi";
const TARGET_CATEGORY_NAMES = {
  guru: "Data Guru",
  siswa: "Data Siswa",
};

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

const DELETE_TYPE_NAMES = ["Lainnya"].map((s) => s.toLowerCase());

function resolveTarget(typeName) {
  const n = typeName.trim().toLowerCase();
  if (GURU_TYPE_NAMES.includes(n)) return "guru";
  if (SISWA_TYPE_NAMES.includes(n)) return "siswa";
  if (DELETE_TYPE_NAMES.includes(n)) return "delete";
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

    // Root folder (folder induk, type_id NULL, parent_id NULL) 
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

    const [adminTypes] = await conn.query(
      "SELECT type_id, type_name FROM document_types WHERE category_id = ?",
      [adminCatId]
    );

    if (adminTypes.length === 0) {
      console.log(`ℹ Kategori "${ADMIN_CATEGORY_NAME}" ditemukan (id=${adminCatId}) tapi tidak punya document_types. Lanjut menghapus kategori & folder induknya saja.`);
    }

    const unresolvedTypes = [];
    const deletedTypesBlocked = [];
    let movedGuru = 0;
    let movedSiswa = 0;
    let deletedTypesCount = 0;

    for (const t of adminTypes) {
      const target = resolveTarget(t.type_name);
      if (!target) {
        unresolvedTypes.push(t);
        continue;
      }

      if (target === "delete") {
        const [[{ cnt }]] = await conn.query(
          "SELECT COUNT(*) AS cnt FROM documents WHERE type_id = ?",
          [t.type_id]
        );
        if (cnt > 0) {
          deletedTypesBlocked.push({ ...t, documentCount: cnt });
          continue;
        }

        await conn.query(
          "DELETE FROM folders WHERE category_id = ? AND type_id = ?",
          [adminCatId, t.type_id]
        );
        await conn.query("DELETE FROM document_types WHERE type_id = ?", [t.type_id]);
        deletedTypesCount++;
        console.log(`  ✓ "${t.type_name}" (type_id=${t.type_id}) -> DIHAPUS (tidak ada dokumen yang memakainya)`);
        continue;
      }

      const newCatId = targetCategoryId[target];
      const rootFolder = target === "guru" ? guruRootFolder : siswaRootFolder;

      await conn.query("UPDATE document_types SET category_id = ? WHERE type_id = ?", [newCatId, t.type_id]);

      await conn.query(
        "UPDATE documents SET category_id = ? WHERE type_id = ? AND category_id = ?",
        [newCatId, t.type_id, adminCatId]
      );

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

    if (deletedTypesBlocked.length > 0) {
      console.warn(`\n⚠ PERLU DITINJAU MANUAL — ${deletedTypesBlocked.length} jenis dokumen seharusnya dihapus tapi MASIH ADA dokumen yang memakainya, jadi TIDAK jadi dihapus supaya dokumen tsb tidak rusak referensinya:`);
      deletedTypesBlocked.forEach((t) => console.warn(`    - "${t.type_name}" (type_id=${t.type_id}) — dipakai oleh ${t.documentCount} dokumen`));
      console.warn(`\nSilakan cek dokumen-dokumen tsb di halaman Arsip dulu (kategori Administrasi -> jenis "${deletedTypesBlocked[0]?.type_name}"), putuskan mau dipindah ke Data Guru/Data Siswa mana, lalu update GURU_TYPE_NAMES/SISWA_TYPE_NAMES pada script ini (bukan DELETE_TYPE_NAMES), lalu jalankan ulang.`);
    }

    if (unresolvedTypes.length > 0 || deletedTypesBlocked.length > 0) {
      if (unresolvedTypes.length > 0) {
        console.warn(`\n⚠ PERLU DITINJAU MANUAL — ${unresolvedTypes.length} jenis dokumen di kategori "Administrasi" TIDAK dikenali dalam daftar pemetaan Guru/Siswa/Delete, sehingga TIDAK dipindahkan otomatis dan kategori "Administrasi" TIDAK akan dihapus dulu supaya data ini tidak hilang:`);
        unresolvedTypes.forEach((t) => console.warn(`    - "${t.type_name}" (type_id=${t.type_id})`));
        console.warn(`\nSilakan tambahkan nama jenis dokumen di atas ke daftar GURU_TYPE_NAMES / SISWA_TYPE_NAMES / DELETE_TYPE_NAMES pada script ini, lalu jalankan ulang.`);
      }
      throw new Error("Ada jenis dokumen yang belum dipetakan/diselesaikan — migrasi dibatalkan (rollback), tidak ada perubahan yang disimpan.");
    }

    const [strayDocsResult] = await conn.query(
      "UPDATE documents SET category_id = ? WHERE category_id = ?",
      [targetCategoryId.guru, adminCatId]
    );
    if (strayDocsResult.affectedRows > 0) {
      console.warn(`⚠ ${strayDocsResult.affectedRows} dokumen dengan category_id Administrasi yang tidak match jenis dokumen manapun dipindahkan paksa ke "Data Guru". Mohon ditinjau manual.`);
    }

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

    await conn.query("DELETE FROM categories WHERE category_id = ?", [adminCatId]);

    await conn.query(
      `INSERT INTO audit_trail (document_id, user_id, action, new_value)
       VALUES (NULL, NULL, ?, ?)`,
      [
        `Migrasi: kategori "Administrasi" dihapus, ${movedGuru} jenis dokumen dipindah ke "Data Guru", ${movedSiswa} ke "Data Siswa", ${deletedTypesCount} jenis dokumen dihapus`,
        JSON.stringify({ movedGuru, movedSiswa, deletedTypesCount, adminCategoryIdRemoved: adminCatId }),
      ]
    );

    await conn.commit();

    console.log(`\n✓ Migrasi selesai.`);
    console.log(`  - ${movedGuru} jenis dokumen dipindah ke "Data Guru"`);
    console.log(`  - ${movedSiswa} jenis dokumen dipindah ke "Data Siswa"`);
    if (deletedTypesCount > 0) {
      console.log(`  - ${deletedTypesCount} jenis dokumen dihapus (tidak ada dokumen yang memakainya)`);
    }
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