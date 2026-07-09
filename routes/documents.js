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
} = require("../services/supabaseStorage");
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

  // Sama seperti insert ke `documents`/`student_records`/dkk: kolom `id` di
  // tabel `audit_trail` adalah `int NOT NULL` TANPA AUTO_INCREMENT, jadi ID
  // harus dihitung manual sebelum INSERT.
  const nextId = await getNextId(conn, "audit_trail");

  await conn.query(`
    INSERT INTO audit_trail
    (
      id,
      document_id,
      approval_request_id,
      user_id,
      action,
      previous_hash,
      current_hash,
      old_value,
      new_value
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    nextId,
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

// ── getNextId ──────────────────────────────────────────────────────────────────
// Workaround untuk skema TiDB/MySQL saat ini: kolom `id` didefinisikan sebagai
// `int NOT NULL` TANPA `AUTO_INCREMENT`, jadi ID berikutnya harus dihitung
// manual sebelum INSERT, untuk SETIAP tabel yang butuh `id` (documents,
// student_records, teacher_records, audit_trail, approval_requests,
// notifications, dst). `FOR UPDATE` dipakai supaya aman dari race condition
// selama masih di dalam transaksi yang sama (conn.beginTransaction()).
// Catatan: fungsi ini juga dipanggil dengan `pool` (bukan `conn`) di beberapa
// tempat yang berjalan di luar transaksi (mis. audit log "Melihat dokumen",
// delete, restore) — itu tetap aman untuk kasus penggunaan tunggal seperti itu,
// hanya saja tidak mendapat proteksi FOR UPDATE lintas-transaksi.
async function getNextId(conn, table) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${table}\` FOR UPDATE`
  );
  return row.nextId;
}

// ── insertNotifications ───────────────────────────────────────────────────────
// Helper untuk insert 1 atau banyak baris ke `notifications` sekaligus, dengan
// `id` dihitung manual secara berurutan (nextId, nextId+1, nextId+2, ...)
// supaya tetap aman walau tabel `notifications` bisa menerima banyak baris
// dalam satu aksi (mis. notifikasi ke semua approver saat upload).
async function insertNotifications(conn, rows) {
  if (!rows || !rows.length) return;
  let nextId = await getNextId(conn, "notifications");
  for (const row of rows) {
    await conn.query(
      `INSERT INTO notifications (id, user_id, message, type, document_id) VALUES (?, ?, ?, ?, ?)`,
      [nextId, row.user_id, row.message, row.type, row.document_id]
    );
    nextId++;
  }
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
      return res.status(403).json({ error: "Anda tidak memiliki akses ke dokumen ini" });
    }

    const [trail] = await pool.query(
      `SELECT at.*, u.nama AS user_nama
       FROM audit_trail at
       LEFT JOIN users u ON u.id = at.user_id
       WHERE at.document_id = ?
       ORDER BY at.id ASC`,
      [req.params.id]
    );

    let metadata = null;
    if (Number(doc.category_id) === 1) {
      const [[m]] = await pool.query("SELECT * FROM student_records WHERE document_id = ?", [doc.id]);
      metadata = m || null;
    } else if (Number(doc.category_id) === 2) {
      const [[m]] = await pool.query("SELECT * FROM teacher_records WHERE document_id = ?", [doc.id]);
      metadata = m || null;
    } else if (Number(doc.category_id) === 3) {
      const [[m]] = await pool.query("SELECT * FROM inventory_items WHERE document_id = ?", [doc.id]);
      metadata = m || null;
    } else if (Number(doc.category_id) === 4) {
      if (Number(doc.type_id) === 10) {
        const [[m]] = await pool.query("SELECT * FROM incoming_letters WHERE document_id = ?", [doc.id]);
        metadata = m || null;
      } else if (Number(doc.type_id) === 11) {
        const [[m]] = await pool.query("SELECT * FROM outgoing_letters WHERE document_id = ?", [doc.id]);
        metadata = m || null;
      } else if (Number(doc.type_id) === 12) {
        const [[m]] = await pool.query("SELECT * FROM sk_records WHERE document_id = ?", [doc.id]);
        metadata = m || null;
      }
    }

    // Catat "Melihat dokumen" ke audit trail (non-blocking).
    // Tetap harus hitung `id` manual (lihat catatan pada getNextId) sebelum
    // insert, walau proses ini sendiri tidak menunggu (fire-and-forget).
    (async () => {
      const nextId = await getNextId(pool, "audit_trail");
      await pool.query(
        "INSERT INTO audit_trail (id, document_id, user_id, action) VALUES (?, ?, ?, 'Melihat dokumen')",
        [nextId, doc.id, req.user.id]
      );
    })().catch(() => {}); // jangan gagalkan response jika audit gagal

    res.json({ document: doc, auditTrail: trail, metadata });
  } catch (e) { next(e); }
});

// ── GET /api/documents/:id/download — URL Supabase Storage bertoken ───────────
router.get("/:id/download", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)          return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Supabase tidak ditemukan untuk dokumen ini" });

    const expiryMinutes = Number(req.query.expiry) || 60;
    const fileUrl = await getFileUrl(doc.file_blob_name, expiryMinutes * 60);

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

// ── GET /api/documents/:id/preview — URL Supabase Storage untuk preview (tanpa audit download) ──
router.get("/:id/preview", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      "SELECT id, judul, file_blob_name, file_url, mime_type, original_filename, deleted_at FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (!doc)           return res.status(404).json({ error: "Dokumen tidak ditemukan" });
    if (doc.deleted_at) return res.status(410).json({ error: "Dokumen sudah dihapus" });
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Supabase tidak ditemukan untuk dokumen ini" });

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
    if (!doc.file_blob_name) return res.status(422).json({ error: "File path Supabase tidak ditemukan" });

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

    // ── Upload ke Supabase Storage DULU (sebelum transaksi DB) ────────────────
    let blob;
    try {
      blob = await uploadFile(req.file, category_id);
    } catch (storageErr) {
      if (storageErr.status) {
        return res.status(storageErr.status).json({ error: storageErr.message });
      }
      console.error("[Upload] Supabase upload gagal:", storageErr.message);
      return res.status(502).json({
        error: "Gagal mengunggah file ke Supabase Storage. Coba lagi beberapa saat.",
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

      // 5. Auto-create approval_request agar dokumen muncul di halaman persetujuan.
      // Kolom `id` di `approval_requests` juga `int NOT NULL` tanpa AUTO_INCREMENT,
      // jadi hitung manual (sama seperti documents/student_records/audit_trail),
      // dan requestId diambil dari nextId ini — bukan dari insertId lagi.
      const requestId = await getNextId(conn, "approval_requests");
      await conn.query(
        `INSERT INTO approval_requests (id, document_id, requester_id, status, requester_note, requested_at)
         VALUES (?, ?, ?, 'pending', NULL, NOW())`,
        [requestId, docId, req.user.id]
      );

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

      // 6. Notifikasi ke approver (Kepala Sekolah & Operator/TU aktif).
      // Sebelumnya INSERT...SELECT langsung tanpa `id` — sekarang ambil dulu
      // daftar approver-nya, baru insert satu-satu lewat insertNotifications()
      // supaya tiap baris dapat `id` manual yang berurutan dan unik.
      const [approvers] = await conn.query(
        `SELECT u.id FROM users u
         WHERE u.role IN ('Kepala Sekolah', 'Operator/TU') AND u.status = 'active' AND u.id != ?`,
        [req.user.id]
      );
      await insertNotifications(
        conn,
        approvers.map((u) => ({
          user_id: u.id,
          message: `Dokumen baru menunggu persetujuan: ${judul}`,
          type: "upload",
          document_id: docId,
        }))
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
      console.error("[Upload] DB error setelah Supabase upload — rolling back file:", blob?.blobName);
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

    // Upload file baru ke Supabase Storage
    let newBlob;
    try {
      newBlob = await uploadFile(req.file, doc.category_id);
    } catch (storageErr) {
      if (storageErr.status) {
        return res.status(storageErr.status).json({ error: storageErr.message });
      }
      return res.status(502).json({ error: "Gagal mengunggah file ke Supabase Storage.", detail: storageErr.message });
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
      // Rollback file baru yang sudah terupload
      if (newBlob?.blobName) await deleteFile(newBlob.blobName).catch(() => {});
      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// ── PATCH /api/documents/:id — update metadata umum ────────────────────────────
router.patch("/:id", requirePermission("documents.edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[doc]] = await conn.query("SELECT * FROM documents WHERE id = ?", [req.params.id]);
    if (!doc) { await conn.rollback(); return res.status(404).json({ error: "Dokumen tidak ditemukan" }); }
    if (doc.deleted_at) { await conn.rollback(); return res.status(410).json({ error: "Dokumen sudah dihapus" }); }

    const fields = ["judul", "folder_id", "tahun_ajaran", "catatan"];
    const updates = [];
    const params = [];
    const oldValue = {};
    const newValue = {};

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f] || null);
        oldValue[f] = doc[f];
        newValue[f] = req.body[f];
      }
    }

    if (updates.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: "Tidak ada field yang diupdate" });
    }

    params.push(req.params.id);
    await conn.query(`UPDATE documents SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`, params);

    await addAudit(conn, req.params.id, req.user.id, "Mengubah metadata dokumen", null, oldValue, newValue);

    await conn.commit();
    res.json({ message: "Dokumen berhasil diperbarui" });
  } catch (e) { await conn.rollback(); next(e); } finally { conn.release(); }
});

// ── POST /api/documents/:id/approve ─────────────────────────────────────────
router.post("/:id/approve", requirePermission("documents.approve"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { comment } = req.body;

    const [r] = await conn.query(
      "UPDATE documents SET status='Disetujui', updated_at=NOW() WHERE id=? AND status='Menunggu'",
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

    // Auto-arsipkan setelah disetujui
    await conn.query(
      "UPDATE documents SET status='Diarsipkan' WHERE id=?",
      [req.params.id]
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

    // Sama seperti di upload: ambil dulu datanya, baru insert lewat
    // insertNotifications() supaya `id` dihitung manual.
    const [[approvedDoc]] = await conn.query(
      "SELECT uploaded_by, judul FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (approvedDoc) {
      await insertNotifications(conn, [
        {
          user_id: approvedDoc.uploaded_by,
          message: `Dokumen "${approvedDoc.judul}" telah disetujui dan diarsipkan`,
          type: "approval",
          document_id: req.params.id,
        },
      ]);
    }

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

    const [[rejectedDoc]] = await conn.query(
      "SELECT uploaded_by, judul FROM documents WHERE id = ?",
      [req.params.id]
    );
    if (rejectedDoc) {
      await insertNotifications(conn, [
        {
          user_id: rejectedDoc.uploaded_by,
          message: `Dokumen "${rejectedDoc.judul}" telah ditolak`,
          type: "rejection",
          document_id: req.params.id,
        },
      ]);
    }

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

    // Pastikan file fisik masih ada di Supabase Storage sebelum dipulihkan,
    // agar tidak ada dokumen "hidup" di DB tanpa file di storage.
    if (doc.file_blob_name) {
      const exists = await checkFileExists(doc.file_blob_name);
      if (!exists) {
        return res.status(409).json({
          error: "File dokumen tidak ditemukan di Supabase Storage, tidak bisa dipulihkan",
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
    const nextId = await getNextId(conn, "student_records");
    await conn.query(
      `INSERT INTO student_records
       (id, document_id, nama_siswa, nis, nisn, kelas, tahun_ajaran,
        tempat_lahir, tanggal_lahir, jenis_kelamin, nama_orang_tua, no_hp_orang_tua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nextId, docId, meta.namaSiswa || null, meta.nis || null, meta.nisn || null, meta.kelas || null,
       meta.tahunAjaran || null, meta.tempatLahir || null, meta.tanggalLahir || null,
       meta.jenisKelamin || null, meta.namaOrangTua || null, meta.noHpOrangTua || null]
    );
  } else if (categoryId === 2) {
    const nextId = await getNextId(conn, "teacher_records");
    await conn.query(
      `INSERT INTO teacher_records
       (id, document_id, nama_guru, nip, nuptk, mata_pelajaran, pendidikan_terakhir, status_kepegawaian)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nextId, docId, meta.namaGuru || null, meta.nip || null, meta.nuptk || null,
       meta.mataPelajaran || null, meta.pendidikanTerakhir || null, meta.statusKepegawaian || null]
    );
  } else if (categoryId === 3) {
    const nextId = await getNextId(conn, "inventory_items");
    await conn.query(
      `INSERT INTO inventory_items
       (id, document_id, kode_barang, nama_barang, jumlah, tahun_pengadaan, kondisi, lokasi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nextId, docId, meta.kodeBarang || null, meta.namaBarang || null, meta.jumlah || null,
       meta.tahunPengadaan || null, meta.kondisi || null, meta.lokasi || null]
    );
  } else if (categoryId === 4) {
    if (typeId === 10) {
      const nextId = await getNextId(conn, "incoming_letters");
      await conn.query(
        `INSERT INTO incoming_letters
         (id, document_id, nomor_agenda, nomor_surat, tanggal_surat, tanggal_diterima, pengirim, perihal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nextId, docId, meta.nomorAgenda || null, meta.nomorSurat || null,
         meta.tanggalSurat || null, meta.tanggalDiterima || null, meta.pengirim || null, meta.perihal || null]
      );
    } else if (typeId === 11) {
      const nextId = await getNextId(conn, "outgoing_letters");
      await conn.query(
        `INSERT INTO outgoing_letters
         (id, document_id, nomor_agenda, nomor_surat, tanggal_surat, tujuan, perihal, penandatangan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nextId, docId, meta.nomorAgenda || null, meta.nomorSurat || null,
         meta.tanggalSurat || null, meta.tujuan || null, meta.perihal || null, meta.penandatangan || null]
      );
    } else if (typeId === 12) {
      const nextId = await getNextId(conn, "sk_records");
      await conn.query(
        `INSERT INTO sk_records
         (id, document_id, nomor_sk, tanggal_sk, tentang, penandatangan)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [nextId, docId, meta.nomorSK || null, meta.tanggalSK || null, meta.tentang || null, meta.penandatangan || null]
      );
    }
  }
}

module.exports = router;