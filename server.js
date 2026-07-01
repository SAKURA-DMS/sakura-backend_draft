require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");

const authRoutes         = require("./routes/auth");
const userRoutes         = require("./routes/users");
const categoryRoutes     = require("./routes/categories");
const folderRoutes       = require("./routes/folders");
const documentRoutes     = require("./routes/documents");
const notificationRoutes = require("./routes/notifications");
const auditRoutes        = require("./routes/audit");
const roleRoutes         = require("./routes/roles");
const approvalRoutes     = require("./routes/approvals");
const dashboardRoutes    = require("./routes/dashboard");
const chatbotRoutes      = require("./routes/chatbot");
const { checkConnection } = require("./config/azureBlob");
const { verifySmtp }      = require("./services/emailService");

const app = express();

// ── Security & middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(",") || "*",
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true }));

let azureStatus = { ok: null, message: "Belum dicek" };

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({
    status:  "ok",
    service: "sakura-dms-backend",
    time:    new Date().toISOString(),
    azure:   azureStatus,
  })
);

app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html><meta charset="utf-8"><title>Sakura DMS API</title>
    <style>body{font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px;color:#222}
    code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style>
    <h1>🌸 Sakura DMS Backend</h1>
    <p>Server berjalan. Ini adalah REST API.</p>
    <ul>
      <li><a href="/api/health"><code>GET /api/health</code></a></li>
      <li><code>POST /api/auth/login</code></li>
      <li><code>POST /api/auth/send-otp</code></li>
      <li><code>POST /api/auth/verify-otp</code></li>
      <li><code>POST /api/auth/enable-2fa</code> (perlu JWT)</li>
      <li><code>POST /api/auth/disable-2fa</code> (perlu JWT)</li>
      <li><code>GET  /api/documents</code> (perlu JWT)</li>
      <li><code>POST /api/approvals</code></li>
      <li><code>POST /api/presence/heartbeat</code> (perlu JWT)</li>
      <li><code>GET  /api/presence/status</code> (perlu JWT)</li>
      <li><code>POST /api/chatbot</code> (perlu JWT)</li>
    </ul>
  `);
});

app.use("/api/auth",          authRoutes);
app.use("/api/users",         userRoutes);
app.use("/api/categories",    categoryRoutes);
app.use("/api/folders",       folderRoutes);
app.use("/api/documents",     documentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/audit",         auditRoutes);
app.use("/api/roles",         roleRoutes);
app.use("/api/approvals",     approvalRoutes);
app.use("/api/dashboard",     dashboardRoutes);
app.use("/api/chatbot",       chatbotRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File terlalu besar. Maksimal ${process.env.MAX_UPLOAD_MB || 25} MB.` });
  }
  if (err.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({ error: "Hanya boleh upload 1 file sekaligus." });
  }
  if (err.status === 415) {
    return res.status(415).json({ error: err.message });
  }
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Sakura DMS backend running on http://localhost:${PORT}`);

  // SMTP health check (non-fatal)
  await verifySmtp();

  // Azure health check (non-fatal)
  try {
    azureStatus = await checkConnection();
    if (azureStatus.ok) {
      console.log(`Azure Blob OK — container: ${azureStatus.container} — ${azureStatus.message}`);
    } else {
      console.warn(`Azure Blob WARNING: ${azureStatus.message}`);
    }
  } catch (e) {
    azureStatus = { ok: false, message: e.message };
    console.warn("Azure Blob check failed:", e.message);
  }
});
