/**
 * Migration: tambah fitur Online Status.
 *
 * Menambahkan kolom `is_online` dan `last_seen_at` ke tabel `users`
 * untuk database yang SUDAH ADA (sudah pernah di-migrate sebelumnya).
 * Instalasi baru tidak perlu menjalankan script ini karena kolom ini
 * sudah ada langsung di database/sakura_dms.sql.
 *
 * Cara pakai:
 *   cd backend
 *   node scripts/add-online-status.js
 *
 * Script ini IDEMPOTENT — aman dijalankan berkali-kali. Jika kolom
 * sudah ada, script akan melewatinya tanpa error.
 */

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
    const hasIsOnline = await columnExists(conn, "users", "is_online");
    if (!hasIsOnline) {
      await conn.query(
        "ALTER TABLE users ADD COLUMN is_online TINYINT(1) NOT NULL DEFAULT 0 AFTER status"
      );
      console.log("✓ Kolom 'is_online' ditambahkan ke tabel users.");
    } else {
      console.log("- Kolom 'is_online' sudah ada, dilewati.");
    }

    const hasLastSeen = await columnExists(conn, "users", "last_seen_at");
    if (!hasLastSeen) {
      await conn.query(
        "ALTER TABLE users ADD COLUMN last_seen_at DATETIME DEFAULT NULL AFTER is_online"
      );
      console.log("✓ Kolom 'last_seen_at' ditambahkan ke tabel users.");
    } else {
      console.log("- Kolom 'last_seen_at' sudah ada, dilewati.");
    }

    console.log("\n✓ Migration Online Status selesai.");
  } catch (e) {
    console.error("✗ Migration gagal:", e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
