process.env.TZ = process.env.TZ || "Asia/Jakarta";

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");
const crypto    = require("crypto");

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
const presenceRoutes     = require("./routes/presence");
const chatbotRoutes      = require("./routes/chatbotRoutes");
const ocrRoutes          = require("./routes/ocr");

const { checkConnection } = require("./services/supabaseStorage");
const { verifySmtp }      = require("./services/emailService");
const { warmupGemini }    = require("./services/geminiService");

const app = express();

app.set("trust proxy", 1);

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const DEFAULT_ALLOWED_ORIGINS = "https://sakuradms.com,https://www.sakuradms.com,https://sakuradms.netlify.app,http://localhost:5173";
const allowedOrigins = (process.env.CORS_ORIGIN || DEFAULT_ALLOWED_ORIGINS)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} tidak diizinkan`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  exposedHeaders: ["Content-Disposition"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  req._reqId = reqId;
  req._startTime = process.hrtime.bigint();

  console.log(`[REQ ${reqId}] ⇢ MIDDLEWARE-GLOBAL: Incoming ${req.method} ${req.originalUrl}`);

  const getDurationMs = () => Number(process.hrtime.bigint() - req._startTime) / 1e6;

  res.on("finish", () => {
    const durationMs = getDurationMs().toFixed(1);
    console.log(
      `[REQ ${reqId}] ⇠ RESPONSE SELESAI: ${req.method} ${req.originalUrl} status=${res.statusCode} duration=${durationMs}ms`
    );
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      const durationMs = getDurationMs().toFixed(1);
      console.warn(
        `[REQ ${reqId}] ⚠ KONEKSI TERPUTUS TANPA RESPONSE: ${req.method} ${req.originalUrl} setelah ${durationMs}ms (kemungkinan hang/timeout di controller atau database)`
      );
    }
  });

  next();
});

app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true }));

let storageStatus = { ok: null, message: "Belum dicek" };

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({
    status:         "ok",
    service:        "sakura-dms-backend",
    time:           new Date().toISOString(),
    supabaseStorage: storageStatus,
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
      <li><code>POST /api/ocr/scan</code> (perlu JWT) — OCR dokumen via Gemini Vision</li>
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
app.use("/api/presence",      presenceRoutes);

app.use("/api/chatbot",       chatbotRoutes);
app.use("/api/ocr",           ocrRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found", path: req.path }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const reqId = req?._reqId || "-";
  console.error(`[REQ ${reqId}] ✖ GLOBAL ERROR HANDLER:`, err.message);
  console.error(`[REQ ${reqId}] Stack trace:`, err.stack);

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

  // Supabase Storage health check (non-fatal)
  try {
    storageStatus = await checkConnection();
    if (storageStatus.ok) {
      console.log(`Supabase Storage OK — bucket: ${storageStatus.bucket} — ${storageStatus.message}`);
    } else {
      console.warn(`Supabase Storage WARNING: ${storageStatus.message}`);
    }
  } catch (e) {
    storageStatus = { ok: false, message: e.message };
    console.warn("Supabase Storage check failed:", e.message);
  }

  // Gemini warm-up (non-fatal) — FIX: mencegah OCR gagal di percobaan
  // pertama akibat cold-start TLS/DNS ke Gemini API. Lihat services/geminiService.js.
  try {
    const geminiStatus = await warmupGemini();
    if (geminiStatus.ok) {
      console.log(`Gemini OCR warm-up OK — ${geminiStatus.message}`);
    } else {
      console.warn(`Gemini OCR warm-up WARNING: ${geminiStatus.message}`);
    }
  } catch (e) {
    console.warn("Gemini OCR warm-up failed:", e.message);
  }
});