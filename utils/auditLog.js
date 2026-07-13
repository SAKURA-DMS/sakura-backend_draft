const { generateAuditHash } = require("./auditHash");

/**
 * utils/auditLog.js
 *
 * Helper terpusat untuk mencatat aktivitas ke `audit_trail` untuk kasus-kasus
 * yang TIDAK terikat pada satu dokumen (login, logout, folder create/rename/
 * delete, OCR scan). Dibuat terpisah dari `addAudit` lokal yang sudah ada di
 * routes/documents.js dan routes/approvals.js supaya:
 *   - logic audit yang sudah berjalan untuk dokumen (upload/edit/delete/
 *     restore/approve/reject/download) TIDAK disentuh sama sekali.
 *   - route baru (auth, folders, ocr) punya satu cara konsisten untuk
 *     menulis log tanpa duplikasi kode.
 *
 * Catatan: memerlukan migration `migration_audit_trail_nullable_document_id.sql`
 * supaya kolom document_id boleh NULL.
 *
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} conn
 * @param {Object} params
 * @param {number|null} [params.documentId]        - null jika aktivitas tidak terikat dokumen
 * @param {number|null} params.userId
 * @param {string} params.action
 * @param {number|null} [params.approvalRequestId]
 * @param {Object|null} [params.oldValue]
 * @param {Object|null} [params.newValue]
 */
async function logActivity(conn, {
  documentId = null,
  userId,
  action,
  approvalRequestId = null,
  oldValue = null,
  newValue = null,
}) {
  const [[lastAudit]] = await conn.query(`
    SELECT current_hash
    FROM audit_trail
    ORDER BY id DESC
    LIMIT 1
  `);

  const previousHash =
    lastAudit && lastAudit.current_hash
      ? lastAudit.current_hash
      : "";

  const auditData = {
    document_id: documentId,
    approval_request_id: approvalRequestId,
    user_id: userId,
    action,
    old_value: oldValue,
    new_value: newValue,
    created_at: new Date()
  };

  const currentHash = generateAuditHash(auditData, previousHash);

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
    documentId,
    approvalRequestId || null,
    userId,
    action,
    previousHash,
    currentHash,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null
  ]);
}

module.exports = { logActivity };