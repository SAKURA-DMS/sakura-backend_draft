const express = require("express");
const pool    = require("../config/db");
const { authRequired }      = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const upload                = require("../middleware/upload");
const { uploadBufferToBlob, generateSasUrl, downloadBlobBuffer, deleteBlob } = require("../config/azureBlob");

const router = express.Router();
router.use(authRequired);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function generateDocumentNumber(conn, typeId) {
  const [[t]] = await conn.query("SELECT code_prefix FROM document_types WHERE type_id = ?", [typeId]);
  if (!t) throw new Error("Tipe dokumen tidak ditemukan");
  const year = new Date().getFullYear();
  const [[counter]] = await conn.query(
    "SELECT last_seq FROM document_counters WHERE prefix = ? AND year = ? FOR UPDATE",
    [t.code_prefix, year]
  );
  let next;
  if (counter) {
    next = counter.last_seq + 1;
    await conn.query(
      "UPDATE document_counters SET last_seq = ? WHERE prefix = ? AND year = ?",
      [next, t.code_prefix, year]
    );
  } else {
    next = 1;
    await conn.query(
      "INSERT INTO document_counters (prefix, year, last_seq) VALUES (?, ?, 1)",
      [t.code_prefix, year]
    );
  }
  return `${t.code_prefix}/${year}/${String(next).padStart(3, "0")}`;
}

async function addAudit(conn, docId, userId, action, approvalRequestId = null) {
  await conn.query(
    "INSERT INTO audit_trail (document_id, approval_request_id, user_id, action) VALUES (?, ?, ?, ?)",
    [docId, approvalRequestId || null, userId, action]
  );
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

// ── GET /api/documents/:id/download — SAS URL sementara (60 menit) ────────────
router.get("/:id/download", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)          return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "Blob name tidak ditemukan untuk dokumen ini" });

    const expiryMinutes = Number(req.query.expiry) || 60;
    const sasUrl = await generateSasUrl(doc.file_blob_name, expiryMinutes);

    // Audit: catat akses download
    await addAudit(pool, doc.id, req.user.id, `Mengunduh dokumen (SAS ${expiryMinutes} menit)`);

    res.json({
      url:           sasUrl,
      expiresInSec:  expiryMinutes * 60,
      filename:      doc.original_filename || doc.judul,
      mimeType:      doc.mime_type,
    });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/preview — SAS URL singkat untuk preview (tanpa audit download) ──
router.get("/:id/preview", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "Blob name tidak ditemukan untuk dokumen ini" });

    const sasUrl = await generateSasUrl(doc.file_blob_name, 15);

    res.json({
      url:      sasUrl,
      filename: doc.original_filename || doc.judul,
      mimeType: doc.mime_type,
    });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/download-stream — proxy stream file asli dari Azure ─
router.get("/:id/download-stream", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "Blob name tidak ditemukan" });

    // Download buffer dari Azure
    const buffer = await downloadBlobBuffer(doc.file_blob_name);

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
    // ── Validasi awal (sebelum menyentuh Azure) ──────────────────────────────
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

    // ── Upload ke Azure Blob DULU (sebelum transaksi DB) ─────────────────────
    let blob;
    try {
      blob = await uploadBufferToBlob(req.file, "documents");
    } catch (azureErr) {
      console.error("[Upload] Azure upload gagal:", azureErr.message);
      return res.status(502).json({
        error: "Gagal mengunggah file ke Azure Storage. Coba lagi beberapa saat.",
        detail: process.env.NODE_ENV !== "production" ? azureErr.message : undefined,
      });
    }

    // ── Transaksi DB ──────────────────────────────────────────────────────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Generate nomor dokumen (dengan lock counter)
      const nomor = await generateDocumentNumber(conn, type_id);

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
      const docId = ins.insertId;

      // 3. Insert metadata per kategori
      await insertMetadata(conn, docId, Number(category_id), Number(type_id), parsedMeta);

      // 4. Audit: upload
      await addAudit(conn, docId, req.user.id,
        `Mengunggah dokumen (${req.file.originalname}, ${(blob.size / 1024).toFixed(1)} KB, ${blob.mimeType})`
      );

      // 5. Auto-create approval_request agar dokumen muncul di halaman persetujuan
      const [aprIns] = await conn.query(
        `INSERT INTO approval_requests (document_id, requester_id, status, requester_note, requested_at)
         VALUES (?, ?, 'pending', NULL, NOW())`,
        [docId, req.user.id]
      );
      const requestId = aprIns.insertId;

      // Audit: pengajuan persetujuan otomatis
      await addAudit(conn, docId, req.user.id, "Mengajukan persetujuan dokumen", requestId);

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
      // Rollback blob yang sudah terupload agar tidak ada orphan
      console.error("[Upload] DB error setelah Azure upload — rolling back blob:", blob?.blobName);
      if (blob?.blobName) {
        await deleteBlob(blob.blobName).catch((e) =>
          console.warn("[Upload] Gagal hapus orphan blob:", e.message)
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

    // Ambil blob lama
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, versi, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });

    // Upload file baru ke Azure
    let newBlob;
    try {
      newBlob = await uploadBufferToBlob(req.file, "documents");
    } catch (azureErr) {
      return res.status(502).json({ error: "Gagal mengunggah file ke Azure Storage.", detail: azureErr.message });
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

      await addAudit(conn, doc.id, req.user.id,
        `Mengganti file (versi ${newVersi}: ${req.file.originalname}, ${(newBlob.size / 1024).toFixed(1)} KB)`
      );

      await conn.commit();

      // Hapus blob lama SETELAH commit DB berhasil
      if (oldBlobName) await deleteBlob(oldBlobName);

      res.json({ message: "File berhasil diganti", versi: newVersi, file_url: newBlob.url });
    } catch (dbErr) {
      await conn.rollback();
      // Rollback new blob
      if (newBlob?.blobName) await deleteBlob(newBlob.blobName).catch(() => {});
      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// ── PATCH /api/documents/:id — edit metadata dasar ───────────────────────────
router.patch("/:id", requirePermission("documents.edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
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
    await addAudit(conn, req.params.id, req.user.id, "Mengedit metadata dokumen");
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

    await addAudit(conn, req.params.id, req.user.id, comment ? `Menyetujui dokumen: "${comment}"` : "Menyetujui dokumen");
    await addAudit(conn, req.params.id, req.user.id, "Dokumen otomatis diarsipkan setelah persetujuan");

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

    await addAudit(conn, req.params.id, req.user.id, `Menolak dokumen: ${reason}`);

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
    await addAudit(pool, req.params.id, req.user.id, "Memindahkan dokumen ke tempat sampah");
    res.json({ message: "Dokumen dipindahkan ke tempat sampah" });
  } catch (e) { next(e); }
});

// ── POST /api/documents/:id/restore ──────────────────────────────────────────
router.post("/:id/restore", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    await pool.query("UPDATE documents SET deleted_at = NULL WHERE id = ?", [req.params.id]);
    await addAudit(pool, req.params.id, req.user.id, "Memulihkan dokumen dari tempat sampah");
    res.json({ message: "Dokumen dipulihkan" });
  } catch (e) { next(e); }
});

// ── DELETE /api/documents/:id/permanent — hapus permanen + blob ───────────────
router.delete("/:id/permanent", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query("SELECT file_blob_name FROM documents WHERE id = ?", [req.params.id]);
    if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.file_blob_name) await deleteBlob(doc.file_blob_name);
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