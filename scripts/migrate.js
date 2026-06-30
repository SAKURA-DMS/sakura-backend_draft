require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

(async () => {
  const conn = await mysql.createConnection({
    host:               process.env.DB_HOST     || "127.0.0.1",
    port:               Number(process.env.DB_PORT || 3306),
    user:               process.env.DB_USER     || "root",
    password:           process.env.DB_PASSWORD || "",
    multipleStatements: true,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });

  try {
    // Jalankan sakura_dms.sql (berisi CREATE DATABASE + semua tabel + data seed)
    const sqlFile = path.join(__dirname, "..", "database", "sakura_dms.sql");
    const sql = fs.readFileSync(sqlFile, "utf8");
    await conn.query(sql);
    console.log(" Berhasil menjalankan: sakura_dms.sql");

    // Pastikan pakai database sakura_dms
    await conn.query("USE sakura_dms");

    // Regenerate password hash untuk user demo agar pasti valid di env ini
    const hash = await bcrypt.hash("password123", 10);
    await conn.query(
      "UPDATE users SET password_hash = ? WHERE email IN (?, ?, ?)",
      [hash, "admin@sakura.sch.id", "principal@sakura.sch.id", "teacher@sakura.sch.id"]
    );
    console.log(" Password user demo di-regenerate ke 'password123'");
    console.log("\n Migration selesai. Login default:");
    console.log("   admin@sakura.sch.id / password123");
    console.log("   principal@sakura.sch.id / password123");
    console.log("   teacher@sakura.sch.id / password123");
  } catch (e) {
    console.error(" Migration gagal:", e.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();