const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();


const PRESENCE_TTL_SECONDS = 45;

// POST /api/presence/offline-beacon?token=...
router.post("/offline-beacon", express.text(), async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).end();
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).end();
    }
    await pool.query("UPDATE users SET is_online = 0 WHERE id = ?", [payload.id]);
    res.status(204).end();
  } catch {
    // sendBeacon tidak membaca response — selalu balas 204 agar browser tidak retry.
    res.status(204).end();
  }
});

router.use(authRequired);

// POST /api/presence/heartbeat — tandai diri sendiri online 
router.post("/heartbeat", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE users SET is_online = 1, last_seen_at = NOW() WHERE id = ?",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/presence/offline 
router.post("/offline", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE users SET is_online = 0 WHERE id = ?",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/presence/status?ids=1,2,3
router.get("/status", async (req, res, next) => {
  try {
    const { ids } = req.query;
    const params = [PRESENCE_TTL_SECONDS];
    let where = "";

    if (ids) {
      const idList = String(ids)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (idList.length === 0) return res.json({ statuses: {} });
      where = `WHERE id IN (${idList.map(() => "?").join(",")})`;
      params.push(...idList);
    }

    const [rows] = await pool.query(
      `SELECT id,
              (is_online = 1 AND last_seen_at IS NOT NULL
                 AND last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)) AS online,
              last_seen_at
       FROM users
       ${where}`,
      params
    );

    const statuses = {};
    for (const row of rows) {
      statuses[row.id] = { online: !!row.online, lastSeenAt: row.last_seen_at };
    }
    res.json({ statuses });
  } catch (e) { next(e); }
});

module.exports = router;
