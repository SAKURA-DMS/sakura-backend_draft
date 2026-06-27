const express = require("express");
const pool    = require("../config/db");
const { authRequired }    = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// ── Helper: filter dokumen berdasarkan role ────────────────────────────────
function buildOwnerFilter(user) {
  if (user.role === "Guru") {
    return { clause: "AND d.uploaded_by = ?", params: [user.id] };
  }
  return { clause: "", params: [] };
}

// ── GET /api/dashboard/stats ──────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const { clause, params } = buildOwnerFilter(req.user);

    const [rows] = await pool.query(
      `SELECT
        COUNT(*)                                              AS total,
        SUM(d.status = 'Menunggu')                           AS menunggu,
        SUM(d.status = 'Diarsipkan')                         AS diarsipkan,
        SUM(d.status = 'Ditolak')                            AS ditolak,
        SUM(d.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS recent_uploads
       FROM documents d
       WHERE d.deleted_at IS NULL ${clause}`,
      params
    );

    const s = rows[0];
    res.json({
      total:         Number(s.total)         || 0,
      menunggu:      Number(s.menunggu)      || 0,
      diarsipkan:    Number(s.diarsipkan)    || 0,
      ditolak:       Number(s.ditolak)       || 0,
      recentUploads: Number(s.recent_uploads)|| 0,
    });
  } catch (e) { next(e); }
});

// ── GET /api/dashboard/chart ──────────────────────────────────────────────────
router.get("/chart", async (req, res, next) => {
  try {
    const { period = "weekly", from, to } = req.query;
    const { clause, params } = buildOwnerFilter(req.user);

    let fromDate = from ? new Date(from) : (() => {
      const d = new Date(); d.setDate(d.getDate() - 6); return d;
    })();
    let toDate = to ? new Date(to) : new Date();

    // Pastikan toDate >= fromDate
    if (toDate < fromDate) { const tmp = fromDate; fromDate = toDate; toDate = tmp; }

    const fromStr = fromDate.toISOString().slice(0, 10);
    const toStr   = toDate.toISOString().slice(0, 10);

    if (period === "weekly") {
      // Per-hari: count upload (created_at) per status
      const [rows] = await pool.query(
        `SELECT
          DATE(d.created_at)         AS date,
          d.status,
          COUNT(*)                   AS cnt
         FROM documents d
         WHERE d.deleted_at IS NULL
           AND DATE(d.created_at) BETWEEN ? AND ?
           ${clause}
         GROUP BY DATE(d.created_at), d.status
         ORDER BY date ASC`,
        [fromStr, toStr, ...params]
      );

      // Build dense map
      const map = {};
      const cur = new Date(fromDate);
      while (cur <= toDate) {
        const key = cur.toISOString().slice(0, 10);
        map[key] = { date: key, Menunggu: 0, Diarsipkan: 0, Ditolak: 0 };
        cur.setDate(cur.getDate() + 1);
      }
      for (const r of rows) {
        const key = r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date).slice(0, 10);
        if (map[key]) map[key][r.status] = Number(r.cnt);
      }

      res.json({ period: "weekly", data: Object.values(map) });

    } else {
      const [rows] = await pool.query(
        `SELECT
          DATE_FORMAT(d.created_at, '%Y-%m') AS month,
          d.status,
          COUNT(*)                            AS cnt
         FROM documents d
         WHERE d.deleted_at IS NULL
           AND DATE_FORMAT(d.created_at, '%Y-%m') BETWEEN ? AND ?
           ${clause}
         GROUP BY DATE_FORMAT(d.created_at, '%Y-%m'), d.status
         ORDER BY month ASC`,
        [fromStr.slice(0, 7), toStr.slice(0, 7), ...params]
      );

      // Build dense monthly map
      const map = {};
      const cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
      const endM = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
      while (cur <= endM) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
        map[key] = { month: key, Menunggu: 0, Diarsipkan: 0, Ditolak: 0 };
        cur.setMonth(cur.getMonth() + 1);
      }
      for (const r of rows) {
        if (map[r.month]) map[r.month][r.status] = Number(r.cnt);
      }

      res.json({ period: "monthly", data: Object.values(map) });
    }
  } catch (e) { next(e); }
});

// ── GET /api/dashboard/activity ───────────────────────────────────────────────
router.get("/activity", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const { clause, params } = buildOwnerFilter(req.user);

    // Build WHERE clause for audit_trail filtered by doc ownership
    const ownerJoin = req.user.role === "Guru"
      ? "AND d.uploaded_by = ?"
      : "";
    const ownerParam = req.user.role === "Guru" ? [req.user.id] : [];

    const [rows] = await pool.query(
      `SELECT
        a.id,
        a.action,
        a.created_at                    AS time,
        u.id                            AS user_id,
        u.nama                          AS user_name,
        u.role                          AS user_role,
        u.avatar                        AS user_avatar,
        d.id                            AS doc_id,
        d.judul                         AS doc_title
       FROM audit_trail a
       JOIN documents d ON d.id = a.document_id
       LEFT JOIN users u ON u.id = a.user_id
       WHERE d.deleted_at IS NULL ${ownerJoin}
       ORDER BY a.created_at DESC
       LIMIT ?`,
      [...ownerParam, limit]
    );

    res.json({
      activity: rows.map((r) => ({
        id:          r.id,
        action:      r.action,
        time:        r.time,
        docId:       r.doc_id,
        docTitle:    r.doc_title,
        userId:      r.user_id,
        userName:    r.user_name || "—",
        userRole:    r.user_role || "—",
        userAvatar:  r.user_avatar || null,
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
