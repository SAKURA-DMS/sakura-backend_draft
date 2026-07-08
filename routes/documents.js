const express = require("express");
const pool    = require("../config/db");
const { authRequired }      = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const upload                = require("../middleware/upload");
const {
  uploadFile,
  deleteFile,
  getFileUrl,
  downloadFileBuffer,
  checkFileExists,
} = require("../services/firebaseStorage");
const { generateAuditHash } = require("../utils/auditHash");

const router = express.Router();
router.use(authRequired);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Format nomor dokumen: [KODE_KATEGORI]-[KODE_JENIS]-[TAHUN]-[RUNNING_NUMBER]
// Contoh: DS-IJZ-2026-000001
// Running number auto-increment per KOMBINASI kategori + jenis (bukan per
// jenis saja), dan reset ke 1 setiap tahun berganti.
async function generateDocumentNumber(conn, categoryId, typeId) {
  const [[cat]] = await conn.query(
    "SELECT code_prefix FROM categories WHERE category_id = ?",
    [categoryId]
  );
  if (!cat) throw new Error("Kategori dokumen tidak ditemukan");

  const [[t]] = await conn.query(
    "SELECT code_prefix FROM document_types WHERE type_id = ?",
    [typeId]
  );
  if (!t) throw new Error("Tipe dokumen tidak ditemukan");

  const categoryCode = cat.code_prefix || "OTH";
  const typeCode      = t.code_prefix   || "OTH";

  const year = new Date().getFullYear();
  // Kunci counter = kombinasi kategori + jenis, supaya "DS-IJZ" dan "DS-RPT"
  // (atau "DG-GRU") masing-masing punya running number sendiri mulai dari 1.
  const comboPrefix = `${categoryCode}-${typeCode}`;

  const [[counter]] = await conn.query(
    "SELECT last_seq FROM document_counters WHERE prefix = ? AND year = ? FOR UPDATE",
    [comboPrefix, year]
  );

  let next;
  if (counter) {
    next = counter.last_seq + 1;
    await conn.query(
      "UPDATE document_counters SET last_seq = ? WHERE prefix = ? AND year = ?",
      [next, comboPrefix, year]
    );
  } else {
    next = 1;
    await conn.query(
      "INSERT INTO document_counters (prefix, year, last_seq) VALUES (?, ?, 1)",
      [comboPrefix, year]
    );
  }

  return `${categoryCode}-${typeCode}-${year}-${String(next).padStart(6, "0")}`;
}

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
    lastAudit && lastAudit.current_hash
      ? lastAudit.current_hash
      : "";

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

// ── GET /api/documents — list dengan filter ───────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { status, category_id, type_id, q, trashed, folder_id, tahun_ajaran } = req.query;
    const where  = [];
    const params = [];

    if (trashed === "true") where.push("d.deleted_at IS NOT NULL");
    else where.push("d.deleted_at IS NULL");

    if (status)      { where.push("d.status = ?");                        params.push(status); }
    if (category_id) { where.push("d.category_id = ?");                   params.push(category_id); }
    if (type_id)     { where.push("d.type_id = ?");                       params.push(type_id); }
    if (folder_id)   { where.push("d.folder_id = ?");                     params.push(folder_id); }
    if (tahun_ajaran){ where.push("d.tahun_ajaran = ?");                  params.push(tahun_ajaran); }
    if (q)           { where.push("(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

    // Guru cuma boleh melihat dokumen miliknya sendiri. Ini di-enforce di
    // level query (bukan cuma disembunyikan di UI) supaya tidak bisa
    // dilewati dengan memanggil API secara langsung.
    if (req.user.role === "Guru") {
      where.push("d.uploaded_by = ?");
      params.push(req.user.id);
    }

    const [rows] = await pool.query(
      `SELECT d.*, u.nama AS uploader_nama, c.category_name, dt.type_name
       FROM documents d
       LEFT JOIN users u  ON u.id          = d.uploaded_by
       LEFT JOIN categories c ON c.category_id = d.category_id
       LEFT JOIN document_types dt ON dt.type_id = d.type_id
       WHERE ${where.join(" AND ")}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ documents: rows });
  } catch (e) { next(e); }
});

// ── GET /api/documents/next-number — preview nomor dokumen berikutnya ─────────
// Dipakai frontend untuk menampilkan field "Nomor Dokumen" (readonly) di form
// upload SEBELUM dokumen benar-benar disimpan. Ini hanya intip nilai
// last_seq+1 tanpa mengunci/menambah counter, jadi nomor final yang benar-benar
// tersimpan (dari generateDocumentNumber saat submit) tetap dijamin unik &
// berurutan walau ada beberapa user yang preview di waktu bersamaan.
router.get("/meta/next-number", async (req, res, next) => {
  try {
    const { category_id, type_id } = req.query;
    if (!category_id) return res.status(400).json({ error: "category_id wajib diisi" });
    if (!type_id)      return res.status(400).json({ error: "type_id wajib diisi" });

    const [[cat]] = await pool.query(
      "SELECT code_prefix FROM categories WHERE category_id = ?",
      [category_id]
    );
    const [[t]] = await pool.query(
      "SELECT code_prefix FROM document_types WHERE type_id = ?",
      [type_id]
    );
    if (!cat) return res.status(404).json({ error: "Kategori tidak ditemukan" });
    if (!t)   return res.status(404).json({ error: "Jenis dokumen tidak ditemukan" });

    const categoryCode = cat.code_prefix || "OTH";
    const typeCode      = t.code_prefix   || "OTH";
    const year = new Date().getFullYear();
    const comboPrefix = `${categoryCode}-${typeCode}`;

    const [[counter]] = await pool.query(
      "SELECT last_seq FROM document_counters WHERE prefix = ? AND year = ?",
      [comboPrefix, year]
    );
    const next = (counter?.last_seq || 0) + 1;
    const nomor_dokumen = `${categoryCode}-${typeCode}-${year}-${String(next).padStart(6, "0")}`;

    res.json({ nomor_dokumen, preview: true });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id — detail + audit trail + metadata ──────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `SELECT d.*, u.nama AS uploader_nama, c.category_name, dt.type_name
       FROM documents d
       LEFT JOIN users u  ON u.id          = d.uploaded_by
       LEFT JOIN categories c ON c.category_id = d.category_id
       LEFT JOIN document_types dt ON dt.type_id = d.type_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (req.user.role === "Guru" && doc.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: "Akses ditolak" });
    }

    const [trail] = await pool.query(
      `SELECT a.*, u.nama, u.role, u.avatar
       FROM audit_trail a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.document_id = ? ORDER BY a.created_at ASC`,
      [req.params.id]
    );

    // Metadata per kategori
    let metadata = null;
    const metaTableByCategory = { 1: "student_records", 2: "teacher_records", 3: "inventory_items" };
    if (metaTableByCategory[doc.category_id]) {
      const [[m]] = await pool.query(
        `SELECT * FROM ${metaTableByCategory[doc.category_id]} WHERE document_id = ?`,
        [doc.id]
      );
      metadata = m || null;
    } else if (doc.category_id === 4) {
      const metaTableByType = { 10: "incoming_letters", 11: "outgoing_letters", 12: "sk_records" };
      const tbl = metaTableByType[doc.type_id];
      if (tbl) {
        const [[m]] = await pool.query(`SELECT * FROM ${tbl} WHERE document_id = ?`, [doc.id]);
        metadata = m || null;
      }
    }

    // Catat "Melihat dokumen" ke audit trail (non-blocking)
    pool.query(
      "INSERT INTO audit_trail (document_id, user_id, action) VALUES (?, ?, 'Melihat dokumen')",
      [doc.id, req.user.id]
    ).catch(() => {}); // jangan gagalkan response jika audit gagal

    res.json({ document: doc, auditTrail: trail, metadata });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/download — URL Firebase Storage bertoken ───────────
router.get("/:id/download", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)          return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Firebase tidak ditemukan untuk dokumen ini" });

    const expiryMinutes = Number(req.query.expiry) || 60;
    const fileUrl = await getFileUrl(doc.file_blob_name);

    // Audit: catat akses download
    await addAudit(pool, doc.id, req.user.id, `Mengunduh dokumen (link ${expiryMinutes} menit)`);

    res.json({
      url:           fileUrl,
      expiresInSec:  expiryMinutes * 60,
      filename:      doc.original_filename || doc.judul,
      mimeType:      doc.mime_type,
    });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/preview — URL Firebase Storage untuk preview (tanpa audit download) ──
router.get("/:id/preview", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Firebase tidak ditemukan untuk dokumen ini" });

    const fileUrl = await getFileUrl(doc.file_blob_name);

    res.json({
      url:      fileUrl,
      filename: doc.original_filename || doc.judul,
      mimeType: doc.mime_type,
    });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/download-stream — proxy stream file asli dari storage ─
router.get("/:id/download-stream", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Firebase tidak ditemukan" });

    // Download buffer dari storage
    const buffer = await downloadFileBuffer(doc.file_blob_name);

    // Audit
    await addAudit(pool, doc.id, req.user.id, "Mengunduh dokumen original (stream)");

    const origName = doc.original_filename || doc.judul;
    const filename = encodeURIComponent(origName);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buffer);
  } catch (e) { next(e); }
});


// ── POST /api/documents — upload dokumen baru ─────────────────────────────────
router.post(
  "/",
  requirePermission("documents.upload"),
  upload.single("file"),
  async (req, res, next) => {
    // ── Validasi awal (sebelum menyentuh storage) ─────────────────────────────
    if (!req.file) {
      return res.status(400).json({ error: "File wajib diupload (field name: file)" });
    }

    const { judul, category_id, type_id, folder_id = null, tahun_ajaran = null, catatan = null, metadata = "{}" } = req.body;

    if (!judul)       return res.status(400).json({ error: "judul wajib diisi" });
    if (!category_id) return res.status(400).json({ error: "category_id wajib diisi" });
    if (!type_id)     return res.status(400).json({ error: "type_id wajib diisi" });

    let parsedMeta;
    try {
      parsedMeta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    } catch {
      return res.status(400).json({ error: "Field metadata bukan JSON valid" });
    }

    // ── Upload ke Firebase Storage DULU (sebelum transaksi DB) ────────────────
    let blob;
    try {
      blob = await uploadFile(req.file, category_id);
    } catch (storageErr) {
      if (storageErr.status) {
        return res.status(storageErr.status).json({ error: storageErr.message });
      }
      console.error("[Upload] Firebase upload gagal:", storageErr.message);
      return res.status(502).json({
        error: "Gagal mengunggah file ke Firebase Storage. Coba lagi beberapa saat.",
        detail: process.env.NODE_ENV !== "production" ? storageErr.message : undefined,
      });
    }

    // ── Transaksi DB ──────────────────────────────────────────────────────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Generate nomor dokumen (dengan lock counter)
      const nomor = await generateDocumentNumber(conn, category_id, type_id);

      // Generate ID manual untuk TiDB
      const [[maxRow]] = await conn.query(
        "SELECT COALESCE(MAX(id),0)+1 AS nextId FROM documents"
      );

      const nextId = maxRow.nextId;

      // 2. Insert dokumen
      const [ins] = await conn.query(
        `INSERT INTO documents
          (id,
            judul, nomor_dokumen, category_id, type_id, folder_id, tahun_ajaran,
            status, versi, uploaded_by,
            file_url, file_blob_name, file_size, mime_type, original_filename, catatan)
          VALUES
          (?, ?, ?, ?, ?, ?, ?, 'Menunggu', 1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nextId,
            judul,
            nomor,
            category_id,
            type_id,
            folder_id || null,
            tahun_ajaran || null,
            req.user.id,
            blob.url,
            blob.blobName,
            blob.size,
            blob.mimeType,
            req.file.originalname,
            catatan || null,
          ]
      );
      const docId = nextId;

      // 3. Insert metadata per kategori
      await insertMetadata(conn, docId, Number(category_id), Number(type_id), parsedMeta);

      // 4. Audit: upload
      await addAudit(
          conn,
          docId,
          req.user.id,
          `Mengunggah dokumen (${req.file.originalname}, ${(blob.size / 1024).toFixed(1)} KB, ${blob.mimeType})`,
          null,
          null,
          {
              status: "Menunggu",
              versi: 1,
              filename: req.file.originalname
          }
      );

      // 5. Auto-create approval_request agar dokumen muncul di halaman persetujuan
      const [aprIns] = await conn.query(
        `INSERT INTO approval_requests (document_id, requester_id, status, requester_note, requested_at)
         VALUES (?, ?, 'pending', NULL, NOW())`,
        [docId, req.user.id]
      );
      const requestId = aprIns.insertId;

      // Audit: pengajuan persetujuan otomatis
      await addAudit(
          conn,
          docId,
          req.user.id,
          "Mengajukan persetujuan dokumen",
          requestId,
          null,
          {
              status: "Menunggu"
          }
      );

      // 6. Notifikasi ke approver (Kepala Sekolah & Operator/TU aktif)
      await conn.query(
        `INSERT INTO notifications (user_id, message, type, document_id)
         SELECT u.id, CONCAT('Dokumen baru menunggu persetujuan: ', ?), 'upload', ?
         FROM users u
         WHERE u.role IN ('Kepala Sekolah', 'Operator/TU') AND u.status = 'active' AND u.id != ?`,
        [judul, docId, req.user.id]
      );

      await conn.commit();
      res.status(201).json({
        id:             docId,
        nomor_dokumen:  nomor,
        file_url:       blob.url,
        file_blob_name: blob.blobName,
        file_size:      blob.size,
        mime_type:      blob.mimeType,
      });
    } catch (dbErr) {
      await conn.rollback();
      // Rollback file yang sudah terupload agar tidak ada orphan
      console.error("[Upload] DB error setelah Firebase upload — rolling back file:", blob?.blobName);
      if (blob?.blobName) {
        await deleteFile(blob.blobName).catch((e) =>
          console.warn("[Upload] Gagal hapus orphan file:", e.message)
        );
      }
      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// ── PATCH /api/documents/:id/file — replace file (re-upload, versi++) ─────────
router.patch(
  "/:id/file",
  requirePermission("documents.edit"),
  upload.single("file"),
  async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: "File baru wajib diupload (field name: file)" });

    // Ambil file lama
    const [[doc]] = await pool.query(
      "SELECT id, judul, category_id, file_blob_name, versi, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });

    // Upload file baru ke Firebase Storage
    let newBlob;
    try {
      newBlob = await uploadFile(req.file, doc.category_id);
    } catch (storageErr) {
      if (storageErr.status) {
        return res.status(storageErr.status).json({ error: storageErr.message });
      }
      return res.status(502).json({ error: "Gagal mengunggah file ke Firebase Storage.", detail: storageErr.message });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const oldBlobName = doc.file_blob_name;
      const newVersi    = (doc.versi || 1) + 1;

      await conn.query(
        `UPDATE documents SET
           file_url          = ?,
           file_blob_name    = ?,
           file_size         = ?,
           mime_type         = ?,
           original_filename = ?,
           versi             = ?,
           updated_at        = NOW()
         WHERE id = ?`,
        [newBlob.url, newBlob.blobName, newBlob.size, newBlob.mimeType, req.file.originalname, newVersi, doc.id]
      );

      await addAudit(
          conn,
          doc.id,
          req.user.id,
          `Mengganti file (versi ${newVersi}: ${req.file.originalname}, ${(newBlob.size / 1024).toFixed(1)} KB)`,
          null,
          {
              versi: doc.versi,
              filename: doc.file_blob_name
          },
          {
              versi: newVersi,
              filename: req.file.originalname
          }
      );

      await conn.commit();

      // Hapus file lama SETELAH commit DB berhasil
      if (oldBlobName) await deleteFile(oldBlobName);

      res.json({ message: "File berhasil diganti", versi: newVersi, file_url: newBlob.url });
    } catch (dbErr) {
      await conn.rollback();
      // Rollback file baru
      if (newBlob?.blobName) await deleteFile(newBlob.blobName).catch(() => {});
      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// ── PATCH /api/documents/:id — edit metadata dasar ───────────────────────────
router.patch("/:id", requirePermission("documents.edit"), async (req, res, next) => {
  const conn = await pool.getConnection();

  const [[oldDoc]] = await conn.query(
    `SELECT
      judul,
      catatan,
      folder_id,
      tahun_ajaran
    FROM documents
    WHERE id=?`,
    [req.params.id]
  );

  try {
    const { judul, catatan, folder_id, tahun_ajaran } = req.body;
    const [r] = await conn.query(
      `UPDATE documents SET
         judul        = COALESCE(?, judul),
         catatan      = COALESCE(?, catatan),
         folder_id    = COALESCE(?, folder_id),
         tahun_ajaran = COALESCE(?, tahun_ajaran),
         updated_at   = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [judul || null, catatan || null, folder_id || null, tahun_ajaran || null, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Dokumen tidak ditemukan atau sudah dihapus" });
    await addAudit(
        conn,
        req.params.id,
        req.user.id,
        "Mengedit metadata dokumen",
        null,
        oldDoc,
        {
          judul: judul !== undefined ? judul : oldDoc.judul,
          catatan: catatan !== undefined ? catatan : oldDoc.catatan,
          folder_id: folder_id !== undefined ? folder_id : oldDoc.folder_id,
          tahun_ajaran: tahun_ajaran !== undefined ? tahun_ajaran : oldDoc.tahun_ajaran
        }
    );
    res.json({ message: "Dokumen diperbarui" });
  } catch (e) { next(e); } finally { conn.release(); }
});

// ── POST /api/documents/:id/approve ──────────────────────────────────────────
router.post("/:id/approve", requirePermission("documents.approve"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { comment = "" } = req.body || {};

    const [r] = await conn.query(
      "UPDATE documents SET status='Diarsipkan', updated_at=NOW() WHERE id=? AND status='Menunggu'",
      [req.params.id]
    );
    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ error: "Dokumen tidak dalam status Menunggu" });
    }

    // Update approval_requests yang pending untuk dokumen ini
    await conn.query(
      `UPDATE approval_requests
         SET status='approved', approver_id=?, approver_note=?, decided_at=NOW()
       WHERE document_id=? AND status='pending'`,
      [req.user.id, comment || null, req.params.id]
    );

    await addAudit(
        conn,
        req.params.id,
        req.user.id,
        comment
          ? `Menyetujui dokumen: "${comment}"`
          : "Menyetujui dokumen",
        null,
        {
            status: "Menunggu"
        },
        {
            status: "Disetujui"
        }
    );
    await addAudit(
        conn,
        req.params.id,
        req.user.id,
        "Dokumen otomatis diarsipkan setelah persetujuan",
        null,
        {
            status: "Disetujui"
        },
        {
            status: "Diarsipkan"
        }
    );

    await conn.query(
      `INSERT INTO notifications (user_id, message, type, document_id)
       SELECT uploaded_by, CONCAT('Dokumen "', judul, '" telah disetujui dan diarsipkan'), 'approval', id
       FROM documents WHERE id = ?`,
      [req.params.id]
    );

    await conn.commit();
    res.json({ message: "Dokumen disetujui" });
  } catch (e) { await conn.rollback(); next(e); } finally { conn.release(); }
});

// ── POST /api/documents/:id/reject ───────────────────────────────────────────
router.post("/:id/reject", requirePermission("documents.reject"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { reason } = req.body;
    if (!reason) { await conn.rollback(); return res.status(400).json({ error: "reason wajib diisi" }); }

    const [r] = await conn.query(
      "UPDATE documents SET status='Ditolak', catatan=?, updated_at=NOW() WHERE id=? AND status='Menunggu'",
      [reason, req.params.id]
    );
    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ error: "Dokumen tidak dalam status Menunggu" });
    }

    // Update approval_requests yang pending untuk dokumen ini
    await conn.query(
      `UPDATE approval_requests
         SET status='rejected', approver_id=?, approver_note=?, decided_at=NOW()
       WHERE document_id=? AND status='pending'`,
      [req.user.id, reason, req.params.id]
    );

    await addAudit(
        conn,
        req.params.id,
        req.user.id,
        `Menolak dokumen: ${reason}`,
        null,
        {
            status: "Menunggu"
        },
        {
            status: "Ditolak",
            alasan: reason
        }
    );

    await conn.query(
      `INSERT INTO notifications (user_id, message, type, document_id)
       SELECT uploaded_by, CONCAT('Dokumen "', judul, '" telah ditolak'), 'rejection', id
       FROM documents WHERE id = ?`,
      [req.params.id]
    );

    await conn.commit();
    res.json({ message: "Dokumen ditolak" });
  } catch (e) { await conn.rollback(); next(e); } finally { conn.release(); }
});

// ── DELETE /api/documents/:id — soft delete (trash) ──────────────────────────
router.delete("/:id", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE documents SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Dokumen tidak ditemukan atau sudah dihapus" });
    await addAudit(
        pool,
        req.params.id,
        req.user.id,
        "Memindahkan dokumen ke tempat sampah",
        null,
        {
            deleted: false
        },
        {
            deleted: true
        }
    );
    res.json({ message: "Dokumen dipindahkan ke tempat sampah" });
  } catch (e) { next(e); }
});

// ── POST /api/documents/:id/restore ──────────────────────────────────────────
router.post("/:id/restore", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, file_blob_name FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });

    // Pastikan file fisik masih ada di Firebase Storage sebelum dipulihkan,
    // agar tidak ada dokumen "hidup" di DB tanpa file di storage.
    if (doc.file_blob_name) {
      const exists = await checkFileExists(doc.file_blob_name);
      if (!exists) {
        return res.status(409).json({
          error: "File dokumen tidak ditemukan di Firebase Storage, tidak bisa dipulihkan",
        });
      }
    }

    await pool.query("UPDATE documents SET deleted_at = NULL WHERE id = ?", [req.params.id]);
    await addAudit(
        pool,
        req.params.id,
        req.user.id,
        "Memulihkan dokumen dari tempat sampah",
        null,
        {
            deleted: true
        },
        {
            deleted: false
        }
    );
    res.json({ message: "Dokumen dipulihkan" });
  } catch (e) { next(e); }
});

// ── DELETE /api/documents/:id/permanent — hapus permanen + file ───────────────
router.delete("/:id/permanent", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query("SELECT file_blob_name FROM documents WHERE id = ?", [req.params.id]);
    if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.file_blob_name) await deleteFile(doc.file_blob_name);
    await pool.query("DELETE FROM documents WHERE id = ?", [req.params.id]);
    res.json({ message: "Dokumen dihapus permanen" });
  } catch (e) { next(e); }
});

// ── insertMetadata ────────────────────────────────────────────────────────────
async function insertMetadata(conn, docId, categoryId, typeId, meta) {
  if (!meta || typeof meta !== "object") return;

  if (categoryId === 1) {
    await conn.query(
      `INSERT INTO student_records
       (document_id, nama_siswa, nis, nisn, kelas, tahun_ajaran,
        tempat_lahir, tanggal_lahir, jenis_kelamin, nama_orang_tua, no_hp_orang_tua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.namaSiswa || null, meta.nis || null, meta.nisn || null, meta.kelas || null,
       meta.tahunAjaran || null, meta.tempatLahir || null, meta.tanggalLahir || null,
       meta.jenisKelamin || null, meta.namaOrangTua || null, meta.noHpOrangTua || null]
    );
  } else if (categoryId === 2) {
    await conn.query(
      `INSERT INTO teacher_records
       (document_id, nama_guru, nip, nuptk, mata_pelajaran, pendidikan_terakhir, status_kepegawaian)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.namaGuru || null, meta.nip || null, meta.nuptk || null,
       meta.mataPelajaran || null, meta.pendidikanTerakhir || null, meta.statusKepegawaian || null]
    );
  } else if (categoryId === 3) {
    await conn.query(
      `INSERT INTO inventory_items
       (document_id, kode_barang, nama_barang, jumlah, tahun_pengadaan, kondisi, lokasi)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.kodeBarang || null, meta.namaBarang || null, meta.jumlah || null,
       meta.tahunPengadaan || null, meta.kondisi || null, meta.lokasi || null]
    );
  } else if (categoryId === 4) {
    if (typeId === 10) {
      await conn.query(
        `INSERT INTO incoming_letters
         (document_id, nomor_agenda, nomor_surat, tanggal_surat, tanggal_diterima, pengirim, perihal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, meta.nomorAgenda || null, meta.nomorSurat || null,
         meta.tanggalSurat || null, meta.tanggalDiterima || null, meta.pengirim || null, meta.perihal || null]
      );
    } else if (typeId === 11) {
      await conn.query(
        `INSERT INTO outgoing_letters
         (document_id, nomor_agenda, nomor_surat, tanggal_surat, tujuan, perihal, penandatangan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, meta.nomorAgenda || null, meta.nomorSurat || null,
         meta.tanggalSurat || null, meta.tujuan || null, meta.perihal || null, meta.penandatangan || null]
      );
    } else if (typeId === 12) {
      await conn.query(
        `INSERT INTO sk_records
         (document_id, nomor_sk, tanggal_sk, tentang, penandatangan)
         VALUES (?, ?, ?, ?, ?)`,
        [docId, meta.nomorSK || null, meta.tanggalSK || null, meta.tentang || null, meta.penandatangan || null]
      );
    }
  }
}

module.exports = router;