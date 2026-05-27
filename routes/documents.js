const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const upload = require("../middleware/upload");
const { uploadBufferToBlob, deleteBlob } = require("../config/azureBlob");

const router = express.Router();
router.use(authRequired);

// Helper: generate nomor dokumen otomatis (PREFIX/YYYY/NNN)
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

async function addAudit(conn, docId, userId, action) {
  await conn.query(
    "INSERT INTO audit_trail (document_id, user_id, action) VALUES (?, ?, ?)",
    [docId, userId, action]
  );
}

// GET /api/documents — list dengan filter
router.get("/", async (req, res, next) => {
  try {
    const { status, category_id, type_id, q, trashed } = req.query;
    const where = [];
    const params = [];
    if (trashed === "true") where.push("d.deleted_at IS NOT NULL");
    else where.push("d.deleted_at IS NULL");
    if (status) { where.push("d.status = ?"); params.push(status); }
    if (category_id) { where.push("d.category_id = ?"); params.push(category_id); }
    if (type_id) { where.push("d.type_id = ?"); params.push(type_id); }
    if (q) { where.push("(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

    const [rows] = await pool.query(
      `SELECT d.*, u.nama AS uploader_nama, c.category_name, dt.type_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN categories c ON c.category_id = d.category_id
       LEFT JOIN document_types dt ON dt.type_id = d.type_id
       WHERE ${where.join(" AND ")}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ documents: rows });
  } catch (e) { next(e); }
});

// GET /api/documents/:id — detail + audit trail + metadata
router.get("/:id", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `SELECT d.*, u.nama AS uploader_nama, c.category_name, dt.type_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
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
    const metaTableByCategory = {
      1: "student_records",
      2: "teacher_records",
      3: "inventory_items",
    };
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

    res.json({ document: doc, auditTrail: trail, metadata });
  } catch (e) { next(e); }
});

// POST /api/documents — upload dokumen baru (multipart/form-data, field: file)
router.post(
  "/",
  requirePermission("documents.upload"),
  upload.single("file"),
  async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      if (!req.file) return res.status(400).json({ error: "File wajib diupload (field: file)" });

      const {
        judul,
        category_id,
        type_id,
        folder_id = null,
        tahun_ajaran = null,
        catatan = null,
        metadata = "{}",
      } = req.body;

      if (!judul || !category_id || !type_id) {
        return res.status(400).json({ error: "judul, category_id, type_id wajib diisi" });
      }

      const parsedMeta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;

      // 1. Upload file ke Azure Blob
      const blob = await uploadBufferToBlob(req.file, "documents");

      await conn.beginTransaction();

      // 2. Generate nomor dokumen
      const nomor = await generateDocumentNumber(conn, type_id);

      // 3. Insert document
      const [ins] = await conn.query(
        `INSERT INTO documents
         (judul, nomor_dokumen, category_id, type_id, folder_id, tahun_ajaran,
          status, versi, uploaded_by, file_url, file_blob_name, file_size, mime_type, original_filename, catatan)
         VALUES (?, ?, ?, ?, ?, ?, 'Menunggu', 1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          judul, nomor, category_id, type_id, folder_id, tahun_ajaran,
          req.user.id, blob.url, blob.blobName, blob.size, blob.mimeType, req.file.originalname, catatan,
        ]
      );
      const docId = ins.insertId;

      // 4. Insert metadata per kategori
      await insertMetadata(conn, docId, Number(category_id), Number(type_id), parsedMeta);

      // 5. Audit
      await addAudit(conn, docId, req.user.id, "Mengunggah dokumen");

      // 6. Notifikasi ke approver
      await conn.query(
        `INSERT INTO notifications (user_id, message, type, document_id)
         SELECT u.id, CONCAT('Dokumen baru menunggu persetujuan: ', ?), 'upload', ?
         FROM users u WHERE u.role IN ('Kepala Sekolah','Operator/TU') AND u.status='active'`,
        [judul, docId]
      );

      await conn.commit();
      res.status(201).json({ id: docId, nomor_dokumen: nomor, file_url: blob.url });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  }
);

async function insertMetadata(conn, docId, categoryId, typeId, meta) {
  if (!meta || typeof meta !== "object") return;
  if (categoryId === 1) {
    await conn.query(
      `INSERT INTO student_records
       (document_id, nama_siswa, nis, nisn, kelas, tahun_ajaran, tempat_lahir, tanggal_lahir, jenis_kelamin, nama_orang_tua, no_hp_orang_tua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.namaSiswa, meta.nis, meta.nisn, meta.kelas, meta.tahunAjaran,
       meta.tempatLahir, meta.tanggalLahir || null, meta.jenisKelamin, meta.namaOrangTua, meta.noHpOrangTua]
    );
  } else if (categoryId === 2) {
    await conn.query(
      `INSERT INTO teacher_records
       (document_id, nama_guru, nip, nuptk, mata_pelajaran, pendidikan_terakhir, status_kepegawaian)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.namaGuru, meta.nip, meta.nuptk, meta.mataPelajaran, meta.pendidikanTerakhir, meta.statusKepegawaian]
    );
  } else if (categoryId === 3) {
    await conn.query(
      `INSERT INTO inventory_items
       (document_id, kode_barang, nama_barang, jumlah, tahun_pengadaan, kondisi, lokasi)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, meta.kodeBarang, meta.namaBarang, meta.jumlah || null, meta.tahunPengadaan, meta.kondisi, meta.lokasi]
    );
  } else if (categoryId === 4) {
    if (typeId === 10) {
      await conn.query(
        `INSERT INTO incoming_letters
         (document_id, nomor_agenda, nomor_surat, tanggal_surat, tanggal_diterima, pengirim, perihal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, meta.nomorAgenda, meta.nomorSurat, meta.tanggalSurat || null, meta.tanggalDiterima || null, meta.pengirim, meta.perihal]
      );
    } else if (typeId === 11) {
      await conn.query(
        `INSERT INTO outgoing_letters
         (document_id, nomor_agenda, nomor_surat, tanggal_surat, tujuan, perihal, penandatangan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, meta.nomorAgenda, meta.nomorSurat, meta.tanggalSurat || null, meta.tujuan, meta.perihal, meta.penandatangan]
      );
    } else if (typeId === 12) {
      await conn.query(
        `INSERT INTO sk_records
         (document_id, nomor_sk, tanggal_sk, tentang, penandatangan)
         VALUES (?, ?, ?, ?, ?)`,
        [docId, meta.nomorSK, meta.tanggalSK || null, meta.tentang, meta.penandatangan]
      );
    }
  }
}

// PATCH /api/documents/:id — edit metadata dasar
router.patch("/:id", requirePermission("documents.edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { judul, catatan, folder_id, tahun_ajaran } = req.body;
    await conn.query(
      `UPDATE documents SET
         judul = COALESCE(?, judul),
         catatan = COALESCE(?, catatan),
         folder_id = COALESCE(?, folder_id),
         tahun_ajaran = COALESCE(?, tahun_ajaran),
         updated_at = NOW()
       WHERE id = ?`,
      [judul || null, catatan || null, folder_id || null, tahun_ajaran || null, req.params.id]
    );
    await addAudit(conn, req.params.id, req.user.id, "Mengedit dokumen");
    res.json({ message: "Dokumen diperbarui" });
  } catch (e) { next(e); } finally { conn.release(); }
});

// POST /api/documents/:id/approve
router.post("/:id/approve", requirePermission("documents.approve"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { comment = "" } = req.body || {};
    const [r] = await conn.query(
      "UPDATE documents SET status='Diarsipkan', updated_at=NOW() WHERE id=? AND status='Menunggu'",
      [req.params.id]
    );
    if (!r.affectedRows) return res.status(400).json({ error: "Dokumen tidak dalam status Menunggu" });
    await addAudit(conn, req.params.id, req.user.id, comment ? `Menyetujui: ${comment}` : "Menyetujui dokumen");
    await addAudit(conn, req.params.id, req.user.id, "Dokumen otomatis diarsipkan setelah persetujuan");
    await conn.query(
      `INSERT INTO notifications (user_id, message, type, document_id)
       SELECT uploaded_by, CONCAT('Dokumen \"', judul, '\" telah disetujui dan diarsipkan'), 'approval', id
       FROM documents WHERE id = ?`,
      [req.params.id]
    );
    res.json({ message: "Dokumen disetujui" });
  } catch (e) { next(e); } finally { conn.release(); }
});

// POST /api/documents/:id/reject
router.post("/:id/reject", requirePermission("documents.reject"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "reason wajib diisi" });
    const [r] = await conn.query(
      "UPDATE documents SET status='Ditolak', catatan=?, updated_at=NOW() WHERE id=? AND status='Menunggu'",
      [reason, req.params.id]
    );
    if (!r.affectedRows) return res.status(400).json({ error: "Dokumen tidak dalam status Menunggu" });
    await addAudit(conn, req.params.id, req.user.id, `Menolak dokumen: ${reason}`);
    await conn.query(
      `INSERT INTO notifications (user_id, message, type, document_id)
       SELECT uploaded_by, CONCAT('Dokumen \"', judul, '\" telah ditolak'), 'rejection', id
       FROM documents WHERE id = ?`,
      [req.params.id]
    );
    res.json({ message: "Dokumen ditolak" });
  } catch (e) { next(e); } finally { conn.release(); }
});

// DELETE /api/documents/:id — soft delete (pindah ke trash)
router.delete("/:id", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    await pool.query("UPDATE documents SET deleted_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ message: "Dokumen dipindahkan ke tempat sampah" });
  } catch (e) { next(e); }
});

// POST /api/documents/:id/restore
router.post("/:id/restore", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    await pool.query("UPDATE documents SET deleted_at = NULL WHERE id = ?", [req.params.id]);
    res.json({ message: "Dokumen dipulihkan" });
  } catch (e) { next(e); }
});

// DELETE /api/documents/:id/permanent — hapus permanen + Azure blob
router.delete("/:id/permanent", requirePermission("documents.delete"), async (req, res, next) => {
  try {
    const [[doc]] = await pool.query("SELECT file_blob_name FROM documents WHERE id = ?", [req.params.id]);
    if (doc?.file_blob_name) await deleteBlob(doc.file_blob_name);
    await pool.query("DELETE FROM documents WHERE id = ?", [req.params.id]);
    res.json({ message: "Dokumen dihapus permanen" });
  } catch (e) { next(e); }
});

module.exports = router;
