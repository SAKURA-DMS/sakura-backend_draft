const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();
router.use(authRequired);

// mysql2 sudah otomatis meng-parse kolom bertipe JSON (old_value, new_value)
// menjadi object/array JS asli. Memanggil JSON.parse() lagi pada value yang
// sudah berupa object akan memicu `object.toString()` -> "[object Object]",
// lalu JSON.parse("[object Object]") melempar SyntaxError — inilah sumber
// error "[object Object] is not valid JSON" yang membuat request /api/audit
// selalu gagal (500) sehingga menu Log tampak selalu kosong.
//
// Fungsi ini aman dipakai baik saat driver DB sudah mem-parse otomatis
// (object/array/null) maupun saat nilainya masih berupa string JSON mentah
// (mis. beda versi driver/konfigurasi), tanpa pernah melempar exception.
function safeParseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value; // sudah ter-parse oleh mysql2
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

// GET /api/audit?document_id=...&limit=...&offset=...
router.get("/", requirePermission("audit.view"), async (req, res, next) => {
  try {
    const { document_id, limit = 200, offset = 0 } = req.query;

    const where = [];
    const params = [];

    if (document_id) {
      where.push("a.document_id = ?");
      params.push(document_id);
    }

    // Batasi limit ke rentang yang wajar supaya query tidak dibanjiri
    // parameter aneh dari client (mis. limit negatif / non-angka).
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const sql = `
      SELECT
        a.*,
        u.nama,
        u.role,
        u.avatar,
        d.judul AS document_judul,
        d.nomor_dokumen AS document_nomor
      FROM audit_trail a
      LEFT JOIN users u
        ON u.id = a.user_id
      LEFT JOIN documents d
        ON d.id = a.document_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(safeLimit, safeOffset);

    const [rows] = await pool.query(sql, params);

    const logs = rows.map((log) => ({
      ...log,

      // FIX: jangan JSON.parse() nilai yang sudah di-parse otomatis oleh
      // mysql2 (lihat penjelasan safeParseJsonColumn di atas).
      old_value: safeParseJsonColumn(log.old_value),
      new_value: safeParseJsonColumn(log.new_value),

      integrity_status:
        log.current_hash
          ? "VALID"
          : "UNKNOWN"
    }));

    res.json({
      logs,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        count: logs.length
      }
    });

  } catch (e) {
    next(e);
  }
});

module.exports = router;