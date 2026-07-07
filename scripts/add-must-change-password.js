require("dotenv").config();
const pool = require("../config/db");

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    const hasFlag = await columnExists(conn, "users", "must_change_password");
    if (!hasFlag) {
      await conn.query(
        "ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER status"
      );
      console.log("✓ Kolom 'must_change_password' ditambahkan ke tabel users.");
    } else {
      console.log("- Kolom 'must_change_password' sudah ada, dilewati.");
    }

    console.log("\n✓ Migration Wajib Ganti Password selesai.");
  } catch (e) {
    console.error("✗ Migration gagal:", e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
