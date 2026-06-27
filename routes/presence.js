/**
 * routes/presence.js — Online Status (Fase Online Status)
 * ─────────────────────────────────────────────────────────────────────────────
 * Solusi RINGAN tanpa WebSocket:
 *  • Frontend mengirim heartbeat berkala (lihat usePresence di AppContext) selagi
 *    tab aktif → menandai user online + memperbarui last_seen_at.
 *  • Status "online" dianggap valid hanya jika last_seen_at masih dalam jendela
 *    PRESENCE_TTL_SECONDS detik terakhir. Ini membuat status otomatis berubah
 *    jadi offline tanpa perlu cron job/scheduler terpisah — cukup dihitung
 *    saat dibaca (query-time expiry).
 *  • Dipanggil juga secara eksplisit saat:
 *      - login           → POST /presence/heartbeat (langsung setelah dapat token)
 *      - logout           → POST /presence/offline
 *      - browser ditutup  → POST /presence/offline lewat navigator.sendBeacon
 *      - token/session habis → request berikutnya gagal 401, frontend berhenti
 *        mengirim heartbeat sehingga TTL akan membuatnya offline otomatis.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// Berapa detik tanpa heartbeat sebelum user dianggap offline meski is_online=1.
// Harus lebih besar dari interval heartbeat frontend (lihat HEARTBEAT_INTERVAL_MS
// di AppContext.jsx) supaya tidak flicker offline di antara dua heartbeat.
const PRESENCE_TTL_SECONDS = 45;

// ── POST /api/presence/offline-beacon?token=... ──────────────────────────────
// Versi khusus dari /offline untuk dipanggil lewat navigator.sendBeacon saat
// tab/browser ditutup (event 'pagehide'). sendBeacon TIDAK BISA menyertakan
// header custom seperti "Authorization: Bearer ...", jadi token JWT dikirim
// lewat query string dan diverifikasi manual di sini (bukan via middleware
// authRequired yang membaca header).
//
// Endpoint ini didaftarkan SEBELUM router.use(authRequired) di bawah supaya
// tidak ikut diwajibkan header Authorization.
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

// ── POST /api/presence/heartbeat — tandai diri sendiri online ────────────────
router.post("/heartbeat", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE users SET is_online = 1, last_seen_at = NOW() WHERE id = ?",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── POST /api/presence/offline — tandai diri sendiri offline ─────────────────
// Dipanggil saat logout eksplisit ATAU lewat navigator.sendBeacon saat tab/
// browser ditutup. sendBeacon mengirim sebagai text/plain, body bisa kosong,
// jadi endpoint ini tidak butuh payload apa pun selain token JWT.
router.post("/offline", async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE users SET is_online = 0 WHERE id = ?",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── GET /api/presence/status?ids=1,2,3 — cek status banyak user sekaligus ────
// Jika `ids` tidak diisi, mengembalikan status SELURUH user (dipakai halaman
// seperti User Management / System Log yang menampilkan banyak avatar).
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
