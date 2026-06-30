const express = require("express");
const pool    = require("../config/db");
const { authRequired }      = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const { generateAuditHash } = require("../utils/auditHash");

const router = express.Router();
router.use(authRequired);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function addAudit(
  conn,
  docId,
  userId,
  action,
  approvalRequestId = null,
  oldValue = null,
  newValue = null
) {

  const [[lastAudit]] = await conn.query(`
    SELECT current_hash
    FROM audit_trail
    ORDER BY id DESC
    LIMIT 1
  `);

  const previousHash =
    lastAudit?.current_hash || "";

  const auditData = {
    document_id: docId,
    approval_request_id: approvalRequestId,
    user_id: userId,
    action,
    old_value: oldValue,
    new_value: newValue,
    created_at: new Date()
  };

  const currentHash =
    generateAuditHash(
      auditData,
      previousHash
    );

  await conn.query(`
    INSERT INTO audit_trail
    (
      document_id,
      approval_request_id,
      user_id,
      action,
      previous_hash,
      current_hash,
      old_value,
      new_value
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    docId,
    approvalRequestId || null,
    userId,
    action,
    previousHash,
    currentHash,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null
  ]);
}

async function sendNotif(conn, userIds, message, type, docId) {
  if (!userIds || userIds.length === 0) return;
  const rows = userIds.map((uid) => [uid, message, type, docId]);
  await conn.query(
    "INSERT INTO notifications (user_id, message, type, document_id) VALUES ?",
    [rows]
  );
}

async function getApprovers(conn, excludeUserId) {
  const [rows] = await conn.query(
    `SELECT id FROM users
     WHERE role IN ('Kepala Sekolah','Operator/TU')
       AND status = 'active'
       AND id != ?`,
    [excludeUserId]
  );
  return rows.map((r) => r.id);
}

// Membersihkan approval_requests yang "yatim": statusnya masih 'pending'
// tapi dokumen terkait sudah tidak lagi berstatus 'Menunggu' (sudah diputuskan
// lewat jalur lain, mis. endpoint /api/documents/:id/approve, atau data lama).
// Tanpa pembersihan ini baris tersebut akan terus muncul di antrian pending
// padahal dokumennya sudah final, dan riwayat di tab "Disetujui/Ditolak" tidak
// pernah terisi karena baris approval_requests-nya tidak ikut terupdate.
async function reconcileOrphanPendingRequests(conn, documentId = null) {
  const where = documentId
    ? "ar.status = 'pending' AND ar.document_id = ? AND d.status != 'Menunggu'"
    : "ar.status = 'pending' AND d.status != 'Menunggu'";
  const params = documentId ? [documentId] : [];

  const [orphans] = await conn.query(
    `SELECT ar.id, ar.document_id, d.status AS doc_status
     FROM approval_requests ar
     JOIN documents d ON d.id = ar.document_id
     WHERE ${where}`,
    params
  );

  for (const o of orphans) {
    const resolvedStatus = o.doc_status === "Ditolak" ? "rejected" : "approved";
    await conn.query(
      `UPDATE approval_requests
         SET status = ?, decided_at = COALESCE(decided_at, NOW())
       WHERE id = ?`,
      [resolvedStatus, o.id]
    );
    await addAudit(
      conn,
      o.document_id,
      null,
      "Status permintaan disinkronkan otomatis dengan status dokumen terkini",
      o.id,
      { status: "Menunggu" },
      { status: o.doc_status }
    );
  }
  return orphans;
}

// ── GET /api/approvals — list request ─────────────────────────────────────────
router.get("/", requirePermission("approvals.view"), async (req, res, next) => {
  try {
    const { status, document_id, requester_id, limit = 100, offset = 0 } = req.query;

    // Self-heal: rapikan dulu baris pending yang dokumennya sudah final
    // (mis. sudah disetujui/ditolak lewat jalur lain) agar antrian pending,
    // riwayat disetujui/ditolak, dan badge count selalu konsisten.
    const cleanupConn = await pool.getConnection();
    try {
      await cleanupConn.beginTransaction();
      await reconcileOrphanPendingRequests(cleanupConn, document_id || null);
      await cleanupConn.commit();
    } catch (cleanupErr) {
      await cleanupConn.rollback();
      console.error("[approvals] Gagal reconcile orphan pending requests:", cleanupErr.message);
    } finally {
      cleanupConn.release();
    }

    const where  = [];
    const params = [];

    if (status)       { where.push("ar.status = ?");       params.push(status); }
    if (document_id)  { where.push("ar.document_id = ?");  params.push(document_id); }
    if (requester_id) { where.push("ar.requester_id = ?"); params.push(requester_id); }

    // Guru hanya boleh lihat request miliknya
    if (req.user.role === "Guru") {
      where.push("ar.requester_id = ?");
      params.push(req.user.id);
    }

    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    const [rows] = await pool.query(
      `SELECT
         ar.id, ar.document_id, ar.status,
         ar.requester_note, ar.approver_note,
         ar.requested_at, ar.decided_at,
         -- requester
         req.id    AS requester_id,
         req.nama  AS requester_nama,
         req.role  AS requester_role,
         req.avatar AS requester_avatar,
         -- approver
         apr.id    AS approver_id,
         apr.nama  AS approver_nama,
         apr.role  AS approver_role,
         -- dokumen
         d.judul, d.nomor_dokumen, d.status AS doc_status,
         d.category_id, d.type_id, d.versi,
         c.category_name,
         dt.type_name
       FROM approval_requests ar
       JOIN users      req ON req.id = ar.requester_id
       LEFT JOIN users apr ON apr.id = ar.approver_id
       JOIN documents  d   ON d.id  = ar.document_id
       LEFT JOIN categories c    ON c.category_id  = d.category_id
       LEFT JOIN document_types dt ON dt.type_id   = d.type_id
       ${whereClause}
       ORDER BY
         (TIMESTAMPDIFF(HOUR, ar.requested_at, NOW()) >= 72) DESC,
         CASE WHEN TIMESTAMPDIFF(HOUR, ar.requested_at, NOW()) >= 72 THEN ar.requested_at END ASC,
         CASE WHEN TIMESTAMPDIFF(HOUR, ar.requested_at, NOW()) < 72  THEN ar.requested_at END DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    // Total count (untuk paginasi)
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM approval_requests ar
       ${whereClause}`,
      params
    );

    res.json({ requests: rows, total });
  } catch (e) { next(e); }
});

// ── GET /api/approvals/:id — detail request ───────────────────────────────────
router.get("/:id", requirePermission("approvals.view"), async (req, res, next) => {
  try {
    const [[ar]] = await pool.query(
      `SELECT
         ar.*,
         req.nama  AS requester_nama,
         req.role  AS requester_role,
         req.avatar AS requester_avatar,
         apr.nama  AS approver_nama,
         apr.role  AS approver_role,
         d.judul, d.nomor_dokumen, d.status AS doc_status,
         d.category_id, d.file_url, d.versi,
         c.category_name,
         dt.type_name
       FROM approval_requests ar
       JOIN users      req ON req.id = ar.requester_id
       LEFT JOIN users apr ON apr.id = ar.approver_id
       JOIN documents  d   ON d.id  = ar.document_id
       LEFT JOIN categories c    ON c.category_id  = d.category_id
       LEFT JOIN document_types dt ON dt.type_id   = d.type_id
       WHERE ar.id = ?`,
      [req.params.id]
    );
    if (!ar) return res.status(404).json({ error: "Approval request tidak ditemukan" });

    // Guru hanya boleh lihat request miliknya
    if (req.user.role === "Guru" && ar.requester_id !== req.user.id) {
      return res.status(403).json({ error: "Akses ditolak" });
    }

    // Audit trail khusus request ini
    const [trail] = await pool.query(
      `SELECT a.*, u.nama, u.role, u.avatar
       FROM audit_trail a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.approval_request_id = ?
       ORDER BY a.created_at ASC`,
      [req.params.id]
    );

    res.json({ request: ar, auditTrail: trail });
  } catch (e) { next(e); }
});

// ── GET /api/approvals/:id/audit — audit trail request ───────────────────────
router.get("/:id/audit", requirePermission("approvals.view"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.nama, u.role, u.avatar
       FROM audit_trail a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.approval_request_id = ?
       ORDER BY a.created_at ASC`,
      [req.params.id]
    );
    res.json({ logs: rows });
  } catch (e) { next(e); }
});

// ── POST /api/approvals — buat approval request baru ─────────────────────────
// Hanya user dengan permission documents.upload (atau approvals.manage) yang bisa request.
router.post("/", requirePermission("approvals.manage"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { document_id, requester_note = "" } = req.body;
    if (!document_id) {
      await conn.rollback();
      return res.status(400).json({ error: "document_id wajib diisi" });
    }

    // Validasi dokumen: harus ada, tidak terhapus, statusnya bukan Diarsipkan
    const [[doc]] = await conn.query(
      "SELECT id, judul, status, uploaded_by, deleted_at FROM documents WHERE id = ?",
      [document_id]
    );
    if (!doc)           { await conn.rollback(); return res.status(404).json({ error: "Dokumen tidak ditemukan" }); }
    if (doc.deleted_at) { await conn.rollback(); return res.status(410).json({ error: "Dokumen sudah dihapus" }); }
    if (doc.status === "Diarsipkan") {
      await conn.rollback();
      return res.status(409).json({ error: "Dokumen sudah diarsipkan, tidak perlu approval lagi" });
    }

    // Guru hanya bisa request untuk dokumen miliknya sendiri
    if (req.user.role === "Guru" && doc.uploaded_by !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ error: "Anda hanya bisa mengajukan persetujuan untuk dokumen milik Anda" });
    }

    // Cek: sudah ada pending request untuk dokumen ini?
    const [[existing]] = await conn.query(
      "SELECT id FROM approval_requests WHERE document_id = ? AND status = 'pending' LIMIT 1",
      [document_id]
    );
    if (existing) {
      await conn.rollback();
      return res.status(409).json({
        error: "Dokumen sudah memiliki approval request yang sedang menunggu",
        existing_request_id: existing.id,
      });
    }

    // Batalkan request lama yang rejected/cancelled (opsional — biarkan history tetap ada, cukup buat baru)
    // Buat approval request baru
    const [ins] = await conn.query(
      `INSERT INTO approval_requests (document_id, requester_id, status, requester_note, requested_at)
       VALUES (?, ?, 'pending', ?, NOW())`,
      [document_id, req.user.id, requester_note || null]
    );
    const requestId = ins.insertId;

    // Update status dokumen → Menunggu
    await conn.query(
      "UPDATE documents SET status = 'Menunggu', updated_at = NOW() WHERE id = ?",
      [document_id]
    );

    // Audit
    const auditMsg = requester_note
      ? `Mengajukan persetujuan: "${requester_note}"`
      : "Mengajukan persetujuan dokumen";
    await addAudit(conn, document_id, req.user.id, auditMsg, requestId, { status: "Menunggu" });

    // Notifikasi ke semua approver
    const approverIds = await getApprovers(conn, req.user.id);
    await sendNotif(
      conn, approverIds,
      `Dokumen baru menunggu persetujuan: "${doc.judul}"`,
      "approval", document_id
    );

    await conn.commit();
    res.status(201).json({
      message:    "Approval request berhasil dibuat",
      request_id: requestId,
      document_id,
    });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// ── POST /api/approvals/:id/approve ──────────────────────────────────────────
router.post("/:id/approve", requirePermission("documents.approve"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { comment = "" } = req.body || {};

    // Ambil request
    const [[ar]] = await conn.query(
      "SELECT * FROM approval_requests WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!ar)                   { await conn.rollback(); return res.status(404).json({ error: "Approval request tidak ditemukan" }); }
    if (ar.status !== "pending") {
      await conn.rollback();
      return res.status(409).json({ error: `Request sudah berstatus '${ar.status}', tidak dapat disetujui` });
    }

    // Validasi dokumen masih 'Menunggu'. Jika dokumen sudah final (mis. sudah
    // diputuskan lewat endpoint lain atau data lama), jangan macet dengan error
    // generik — selaraskan saja status request ini supaya konsisten lalu kabari
    // pengguna apa yang sebenarnya terjadi.
    const [[doc]] = await conn.query(
      "SELECT id, judul, status, uploaded_by FROM documents WHERE id = ? FOR UPDATE",
      [ar.document_id]
    );
    if (!doc) {
      await conn.rollback();
      return res.status(404).json({ error: "Dokumen terkait tidak ditemukan" });
    }
    if (doc.status !== "Menunggu") {
      const resolvedStatus = doc.status === "Ditolak" ? "rejected" : "approved";
      await conn.query(
        `UPDATE approval_requests
           SET status = ?, decided_at = COALESCE(decided_at, NOW())
         WHERE id = ?`,
        [resolvedStatus, ar.id]
      );
      await addAudit(
        conn, ar.document_id, req.user.id,
        "Status permintaan disinkronkan otomatis dengan status dokumen terkini",
        ar.id,
        { status: "Menunggu" },
        { status: doc.status }
      );
      await conn.commit();
      return res.status(409).json({
        error: `Dokumen ini sudah berstatus '${doc.status}' (diputuskan sebelumnya), permintaan persetujuan ini sudah disinkronkan otomatis dan tidak perlu ditindaklanjuti lagi.`,
        already_resolved: true,
        document_status: doc.status,
      });
    }

    // Update approval_request
    await conn.query(
      `UPDATE approval_requests
         SET status = 'approved', approver_id = ?, approver_note = ?, decided_at = NOW()
       WHERE id = ?`,
      [req.user.id, comment || null, ar.id]
    );

    // Update dokumen → Diarsipkan
    await conn.query(
      "UPDATE documents SET status = 'Diarsipkan', updated_at = NOW() WHERE id = ?",
      [ar.document_id]
    );

    // Selesaikan juga approval_requests pending lain untuk dokumen yang sama
    // (jika ada duplikat) agar tidak ada baris yatim yang tersisa di antrian.
    await conn.query(
      `UPDATE approval_requests
         SET status = 'approved', approver_id = ?, decided_at = NOW()
       WHERE document_id = ? AND status = 'pending' AND id != ?`,
      [req.user.id, ar.document_id, ar.id]
    );

    // Audit (dua entry: keputusan + otomatis arsip)
    const approveMsg = comment
      ? `Menyetujui dokumen: "${comment}"`
      : "Menyetujui dokumen";
    await addAudit(conn, ar.document_id, req.user.id, approveMsg, ar.id, { status: "Menunggu" }, { status: "Disetujui" });
    await addAudit(conn, ar.document_id, req.user.id, "Dokumen otomatis diarsipkan setelah persetujuan", ar.id, { status: "Disetujui" }, { status: "Diarsipkan" });

    // Notifikasi ke requester (uploader)
    await sendNotif(
      conn, [doc.uploaded_by],
      `Dokumen "${doc.judul}" telah disetujui dan diarsipkan`,
      "approval", ar.document_id
    );

    await conn.commit();
    res.json({ message: "Dokumen disetujui dan diarsipkan", request_id: ar.id });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// ── POST /api/approvals/:id/reject ───────────────────────────────────────────
router.post("/:id/reject", requirePermission("documents.reject"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      await conn.rollback();
      return res.status(400).json({ error: "reason wajib diisi" });
    }

    // Ambil request
    const [[ar]] = await conn.query(
      "SELECT * FROM approval_requests WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!ar)                   { await conn.rollback(); return res.status(404).json({ error: "Approval request tidak ditemukan" }); }
    if (ar.status !== "pending") {
      await conn.rollback();
      return res.status(409).json({ error: `Request sudah berstatus '${ar.status}', tidak dapat ditolak` });
    }

    // Validasi dokumen. Jika sudah final lewat jalur lain, selaraskan saja
    // daripada memberi error yang tidak bisa ditindaklanjuti dari UI.
    const [[doc]] = await conn.query(
      "SELECT id, judul, status, uploaded_by FROM documents WHERE id = ? FOR UPDATE",
      [ar.document_id]
    );
    if (!doc) {
      await conn.rollback();
      return res.status(404).json({ error: "Dokumen terkait tidak ditemukan" });
    }
    if (doc.status !== "Menunggu") {
      const resolvedStatus = doc.status === "Ditolak" ? "rejected" : "approved";
      await conn.query(
        `UPDATE approval_requests
           SET status = ?, decided_at = COALESCE(decided_at, NOW())
         WHERE id = ?`,
        [resolvedStatus, ar.id]
      );
      await addAudit(
        conn, ar.document_id, req.user.id,
        "Status permintaan disinkronkan otomatis dengan status dokumen terkini",
        ar.id,
        { status: "Menunggu" },
        { status: doc.status }
      );
      await conn.commit();
      return res.status(409).json({
        error: `Dokumen ini sudah berstatus '${doc.status}' (diputuskan sebelumnya), permintaan persetujuan ini sudah disinkronkan otomatis dan tidak perlu ditindaklanjuti lagi.`,
        already_resolved: true,
        document_status: doc.status,
      });
    }

    // Update approval_request
    await conn.query(
      `UPDATE approval_requests
         SET status = 'rejected', approver_id = ?, approver_note = ?, decided_at = NOW()
       WHERE id = ?`,
      [req.user.id, reason.trim(), ar.id]
    );

    // Update dokumen → Ditolak, simpan alasan di catatan
    await conn.query(
      "UPDATE documents SET status = 'Ditolak', catatan = ?, updated_at = NOW() WHERE id = ?",
      [reason.trim(), ar.document_id]
    );

    // Selesaikan juga approval_requests pending lain untuk dokumen yang sama
    await conn.query(
      `UPDATE approval_requests
         SET status = 'rejected', approver_id = ?, approver_note = ?, decided_at = NOW()
       WHERE document_id = ? AND status = 'pending' AND id != ?`,
      [req.user.id, reason.trim(), ar.document_id, ar.id]
    );

    // Audit
    await addAudit(conn, ar.document_id, req.user.id, `Menolak dokumen: "${reason.trim()}"`, ar.id, { status: "Menunggu" }, { status: "Ditolak", alasan: reason.trim() });

    // Notifikasi ke requester
    await sendNotif(
      conn, [doc.uploaded_by],
      `Dokumen "${doc.judul}" ditolak. Alasan: ${reason.trim()}`,
      "rejection", ar.document_id
    );

    await conn.commit();
    res.json({ message: "Dokumen ditolak", request_id: ar.id });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

// ── POST /api/approvals/:id/cancel ───────────────────────────────────────────
// Hanya requester (pemilik request) atau admin yang bisa cancel.
router.post("/:id/cancel", requirePermission("approvals.manage"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ar]] = await conn.query(
      "SELECT * FROM approval_requests WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!ar) { await conn.rollback(); return res.status(404).json({ error: "Approval request tidak ditemukan" }); }

    // Hanya requester atau role admin (Kepala Sekolah/Operator/TU) bisa cancel
    const isOwner = ar.requester_id === req.user.id;
    const isAdmin = ["Kepala Sekolah", "Operator/TU"].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      await conn.rollback();
      return res.status(403).json({ error: "Hanya pemilik request atau admin yang dapat membatalkan" });
    }

    if (ar.status !== "pending") {
      await conn.rollback();
      return res.status(409).json({ error: `Request sudah berstatus '${ar.status}', tidak dapat dibatalkan` });
    }

    // Cancel request
    await conn.query(
      "UPDATE approval_requests SET status = 'cancelled', decided_at = NOW() WHERE id = ?",
      [ar.id]
    );

    await conn.query(
      "UPDATE documents SET status = 'Ditolak', catatan = 'Pengajuan dibatalkan oleh pengguna', updated_at = NOW() WHERE id = ? AND status = 'Menunggu'",
      [ar.document_id]
    );

    // Audit
    await addAudit(conn, ar.document_id, req.user.id, "Membatalkan pengajuan persetujuan", ar.id, { status: "Menunggu" }, { status: "Dibatalkan" });

    await conn.commit();
    res.json({ message: "Approval request dibatalkan", request_id: ar.id });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

module.exports = router;