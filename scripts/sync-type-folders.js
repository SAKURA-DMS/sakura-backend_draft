require("dotenv").config();
const pool = require("../config/db");

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [missingTypes] = await conn.query(`
      SELECT dt.type_id, dt.type_name, dt.category_id, c.category_name
      FROM document_types dt
      JOIN categories c ON c.category_id = dt.category_id
      LEFT JOIN folders f ON f.category_id = dt.category_id AND f.type_id = dt.type_id
      WHERE f.folder_id IS NULL
      ORDER BY dt.category_id, dt.type_id
    `);

    if (missingTypes.length === 0) {
      console.log("✓ Semua document_types sudah punya folder. Tidak ada yang perlu dibuat.");
      await conn.rollback();
      return;
    }

    console.log(`Ditemukan ${missingTypes.length} jenis dokumen yang belum punya folder:`);

    const rootFolderCache = new Map();
    let createdCount = 0;

    for (const t of missingTypes) {
      let rootFolder = rootFolderCache.get(t.category_id);

      if (rootFolder === undefined) {
        const [[row]] = await conn.query(
          "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
          [t.category_id]
        );
        rootFolder = row || null;
        rootFolderCache.set(t.category_id, rootFolder);

        if (!rootFolder) {
          console.warn(`  ⚠ Folder induk untuk kategori "${t.category_name}" (category_id=${t.category_id}) tidak ditemukan — folder untuk jenis dokumen di kategori ini akan dibuat sebagai folder tanpa induk (parent_id NULL). Mohon ditinjau manual nanti.`);
        }
      }

      const [[row]] = await conn.query("SELECT COALESCE(MAX(folder_id), 0) AS maxId FROM folders FOR UPDATE");
      const newFolderId = row.maxId + 1;

      await conn.query(
        `INSERT INTO folders (folder_id, folder_name, parent_id, category_id, type_id, description, is_custom)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [
          newFolderId,
          t.type_name,
          rootFolder ? rootFolder.folder_id : null,
          t.category_id,
          t.type_id,
          `Folder jenis dokumen "${t.type_name}" (dibuat otomatis oleh sync-type-folders.js).`,
        ]
      );

      createdCount++;
      console.log(`  ✓ Folder "${t.type_name}" (type_id=${t.type_id}) dibuat di bawah "${t.category_name}" (folder_id=${newFolderId})`);
    }

    await conn.query(
      `INSERT INTO audit_trail (document_id, user_id, action, new_value)
       VALUES (NULL, NULL, ?, ?)`,
      [
        `Migrasi: ${createdCount} folder jenis dokumen dibuat otomatis (sync-type-folders.js)`,
        JSON.stringify({ createdCount, types: missingTypes.map((t) => ({ type_id: t.type_id, type_name: t.type_name, category_id: t.category_id })) }),
      ]
    );

    await conn.commit();

    console.log(`\n✓ Selesai. ${createdCount} folder baru dibuat.`);
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