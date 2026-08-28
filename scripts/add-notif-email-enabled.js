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
    const hasNotifEmailEnabled = await columnExists(conn, "users", "notif_email_enabled");
    if (!hasNotifEmailEnabled) {
      await conn.query(
        "ALTER TABLE users ADD COLUMN notif_email_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_2fa_enabled"
      );
      console.log("✓ Kolom 'notif_email_enabled' ditambahkan ke tabel users (default: aktif).");
    } else {
      console.log("- Kolom 'notif_email_enabled' sudah ada, dilewati.");
    }

    console.log("\n✓ Migration Notification Email Preference selesai.");
  } catch (e) {
    console.error("✗ Migration gagal:", e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();