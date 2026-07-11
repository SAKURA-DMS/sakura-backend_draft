const mysql = require("mysql2/promise");

const APP_TIMEZONE_OFFSET = "+07:00"; // Asia/Jakarta (WIB)

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "sakura_dms",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  dateStrings: true,
  timezone: APP_TIMEZONE_OFFSET,
});

// Pastikan setiap koneksi baru di pool memakai session time_zone yang sama
// (bukan default server/TiDB), supaya NOW() / CURRENT_TIMESTAMP konsisten WIB.
pool.on("connection", (connection) => {
  connection.query(`SET time_zone = '${APP_TIMEZONE_OFFSET}'`).catch((err) => {
    console.error("[DB] Gagal mengatur session time_zone:", err.message);
  });
});

module.exports = pool;