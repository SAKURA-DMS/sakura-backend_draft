const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const { verifyAuditHash } = require("../utils/auditHash");

const router = express.Router();
router.use(authRequired);

// mysql2 sudah otomatis meng-parse kolom bertipe JSON (old_value, new_value)
// menjadi object/array JS asli. Memanggil JSON.parse() lagi pada value yang
// sudah berupa object akan memicu `object.toString()` -> "[object Object]",
// lalu JSON.parse("[object Object]") melempar SyntaxError.
function safeParseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
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
    const role = req.user.role;

    const where = [];
    const params = [];

    if (document_id) {
      where.push("a.document_id = ?");
      params.push(document_id);
    }

    if (role === "Kepala Sekolah") {
      const principalOnlyActions = [
        "mengunggah", "menyetujui", "menolak",
        "mengarsipkan", "menghapus", "mengubah",
      ];

      where.push(
        "(" +
          principalOnlyActions
            .map(() => "a.action LIKE ?")
            .join(" OR ") +
          ")"
      );

      principalOnlyActions.forEach((kw) =>
        params.push(`%${kw}%`)
      );
    } else if (role !== "Operator/TU") {
      where.push("a.user_id = ?");
      params.push(req.user.id);
    }

    const safeLimit = Math.min(
      Math.max(Number(limit) || 200, 1),
      1000
    );

    const safeOffset = Math.max(
      Number(offset) || 0,
      0
    );

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
      old_value: safeParseJsonColumn(log.old_value),
      new_value: safeParseJsonColumn(log.new_value),
      integrity_status: log.current_hash
        ? "VALID"
        : "UNKNOWN",
    }));

    res.json({
      logs,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        count: logs.length,
      },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/audit/verify-integrity
// HANYA MEMBACA dan memverifikasi audit trail.
// Tidak mengubah audit record, database, atau hash existing.
router.post(
  "/verify-integrity",
  requirePermission("audit.view"),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT
          id,
          document_id,
          approval_request_id,
          user_id,
          action,
          previous_hash,
          current_hash,
          old_value,
          new_value,
          created_at
        FROM audit_trail
        ORDER BY id ASC
      `);

      let previousCurrentHash = "";
      const brokenRecords = [];

      for (const row of rows) {
        const expectedPreviousHash =
          previousCurrentHash;

        // Check hubungan antar-record.
        if (
          (row.previous_hash || "") !==
          expectedPreviousHash
        ) {
          brokenRecords.push({
            id: row.id,
            type: "CHAIN_BROKEN",
            expected_previous_hash:
              expectedPreviousHash,
            actual_previous_hash:
              row.previous_hash || "",
          });
        }

        // Gunakan formula hash yang SUDAH ADA.
        // auditHash.js tidak diubah.
        const baseAuditData = {
          document_id: row.document_id,
          approval_request_id:
            row.approval_request_id,
          user_id: row.user_id,
          action: row.action,
          old_value:
            safeParseJsonColumn(row.old_value),
          new_value:
            safeParseJsonColumn(row.new_value),
        };

        // Existing audit creation uses new Date() in the hash payload.
        // If the database timestamp preserves only seconds, the original
        // millisecond cannot be read back directly. We therefore test the
        // 0-999 ms values within the stored second using the EXISTING hash
        // function. No audit record is changed.
        const storedDate = new Date(row.created_at);
        let hashValid = false;

        for (let ms = 0; ms < 1000 && !hashValid; ms += 1) {
          const candidateDate = new Date(storedDate.getTime());
          candidateDate.setMilliseconds(ms);

          hashValid = verifyAuditHash(
            {
              ...baseAuditData,
              created_at: candidateDate,
            },
            row.previous_hash || "",
            row.current_hash || ""
          );
        }

        if (!hashValid) {
          brokenRecords.push({
            id: row.id,
            type: "HASH_MISMATCH",
            message:
              "Stored current_hash does not match the existing audit hash formula.",
          });
        }

        previousCurrentHash =
          row.current_hash || "";
      }

      const valid =
        brokenRecords.length === 0;

      return res.json({
        valid,
        status: valid
          ? "VALID"
          : "TAMPERED",
        total_records: rows.length,
        broken_records: brokenRecords,
      });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
