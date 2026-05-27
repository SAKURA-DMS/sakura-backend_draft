require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const categoryRoutes = require("./routes/categories");
const folderRoutes = require("./routes/folders");
const documentRoutes = require("./routes/documents");
const notificationRoutes = require("./routes/notifications");
const auditRoutes = require("./routes/audit");
const roleRoutes = require("./routes/roles");

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Basic rate limit on auth endpoints to slow brute force
app.use(
  "/api/auth",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true })
);

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", service: "sakura-dms-backend", time: new Date().toISOString() })
);

// Halaman info di root supaya tidak tampil "Not Found" saat dibuka di browser.
app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html><meta charset="utf-8"><title>Sakura DMS API</title>
    <style>body{font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px;color:#222}
    code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>
    <h1>🌸 Sakura DMS Backend</h1>
    <p>Server berjalan. Ini adalah REST API — bukan halaman web.</p>
    <p>Coba endpoint:</p>
    <ul>
      <li><a href="/api/health"><code>GET /api/health</code></a></li>
      <li><code>POST /api/auth/login</code></li>
      <li><code>GET /api/documents</code> (perlu JWT)</li>
    </ul>
    <p>Frontend React harus memanggil <code>http://localhost:5000/api/*</code>.</p>
  `);
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/roles", roleRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Sakura DMS backend running on http://localhost:${PORT}`);
});
