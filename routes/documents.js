const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const upload = require("../middleware/upload");
const {
  uploadFile,
  deleteFile,
  getFileUrl,
  downloadFileBuffer,
  checkFileExists,
} = require("../services/supabaseStorage");
const { generateAuditHash } = require("../utils/auditHash");
const { normalizeDateToISO } = require("../utils/dateParser");
const { sendNotificationEmail } = require("../services/emailService");

const router = express.Router();
router.use(authRequired);

// Helpers

// Kirim email notifikasi ke user (dari daftar userIds) yang mengaktifkan
// toggle "Email" di Pengaturan Sistem > Notifikasi. Dipanggil setelah
// notifikasi in-app dibuat; kegagalan kirim email tidak mempengaruhi
// proses utama (tidak dilempar sebagai error).
async function notifyEmailForUsers(conn, userIds, message, eventLabel) {
  if (!userIds || userIds.length === 0) return;
  try {
    const [emailTargets] = await conn.query(
      `SELECT id, nama, email FROM users
       WHERE id IN (?) AND notif_email_enabled = 1`,
      [userIds]
    );
    for (const target of emailTargets) {
      sendNotificationEmail({
        to: target.email,
        namaUser: target.nama,
        message,
        eventLabel,
      }).catch((err) => {
        console.error("Gagal mengirim email notifikasi:", err.message);
      });
    }
  } catch (err) {
    console.error("Gagal mengambil daftar penerima email notifikasi:", err.message);
  }
}


// Format no. dokumen: [KODE_KATEGORI]-[KODE_JENIS]-[TAHUN]-[RUNNING_NUMBER]
// Example: DS-IJZ-2026-000001
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
  const typeCode = t.code_prefix || "OTH";

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
    created_at: new Date(),
  };

  const currentHash = generateAuditHash(
    auditData,
    previousHash
  );

  await conn.query(
    `
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
    `,
    [
      docId,
      approvalRequestId || null,
      userId,
      action,
      previousHash,
      currentHash,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
    ]
  );
}

// Sensitive doc access helper 
// Operator/TU & Kepala Sekolah tetap memiliki akses penuh.
async function assertSensitiveAccess(conn, doc, user) {
  if (!doc.is_sensitive) return;

  if (user.role !== "Guru") return;

  if (Number(doc.uploaded_by) === Number(user.id)) return;

  const [[owned]] = await conn.query(
    "SELECT 1 FROM document_owners WHERE document_id = ? AND user_id = ? LIMIT 1",
    [doc.id, user.id]
  );

  if (!owned) {
    const err = new Error("Anda tidak memiliki izin membuka dokumen ini.");
    err.status = 403;
    throw err;
  }
}

// GET /api/documents - list dengan filter 
router.get("/", async (req, res, next) => {
  try {
    const {
      status,
      category_id,
      type_id,
      q,
      trashed,
      folder_id,
      tahun_ajaran,
    } = req.query;

    const where = [];
    const params = [];

    if (trashed === "true") {
      where.push("d.deleted_at IS NOT NULL");
    } else {
      where.push("d.deleted_at IS NULL");
    }

    if (status) {
      where.push("d.status = ?");
      params.push(status);
    }

    if (category_id) {
      where.push("d.category_id = ?");
      params.push(category_id);
    }

    if (type_id) {
      where.push("d.type_id = ?");
      params.push(type_id);
    }

    if (folder_id) {
      where.push("d.folder_id = ?");
      params.push(folder_id);
    }

    if (tahun_ajaran) {
      where.push("d.tahun_ajaran = ?");
      params.push(tahun_ajaran);
    }

    if (q) {
      where.push(
        "(d.judul LIKE ? OR d.nomor_dokumen LIKE ?)"
      );
      params.push(`%${q}%`, `%${q}%`);
    }

    // Document Access Filter (Archive Rules) 
    const [rows] = await pool.query(
      `
      SELECT
        d.*,
        u.nama AS uploader_nama,
        c.category_name,
        dt.type_name
      FROM documents d
      LEFT JOIN users u
        ON u.id = d.uploaded_by
      LEFT JOIN categories c
        ON c.category_id = d.category_id
      LEFT JOIN document_types dt
        ON dt.type_id = d.type_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC
      `,
      params
    );

    res.json({ documents: rows });
  } catch (e) {
    next(e);
  }
});

// GET /api/documents/next-number - preview no document
router.get("/meta/next-number", async (req, res, next) => {
  try {
    const { category_id, type_id } = req.query;

    if (!category_id) {
      return res.status(400).json({
        error: "category_id wajib diisi",
      });
    }

    if (!type_id) {
      return res.status(400).json({
        error: "type_id wajib diisi",
      });
    }

    const [[cat]] = await pool.query(
      "SELECT code_prefix FROM categories WHERE category_id = ?",
      [category_id]
    );

    const [[t]] = await pool.query(
      "SELECT code_prefix FROM document_types WHERE type_id = ?",
      [type_id]
    );

    if (!cat) {
      return res.status(404).json({
        error: "Kategori tidak ditemukan",
      });
    }

    if (!t) {
      return res.status(404).json({
        error: "Jenis dokumen tidak ditemukan",
      });
    }

    const categoryCode = cat.code_prefix || "OTH";
    const typeCode = t.code_prefix || "OTH";
    const year = new Date().getFullYear();
    const comboPrefix = `${categoryCode}-${typeCode}`;

    const [[counter]] = await pool.query(
      "SELECT last_seq FROM document_counters WHERE prefix = ? AND year = ?",
      [comboPrefix, year]
    );

    const next = (counter?.last_seq || 0) + 1;

    const nomor_dokumen =
      `${categoryCode}-${typeCode}-${year}-${String(next).padStart(6, "0")}`;

    res.json({
      nomor_dokumen,
      preview: true,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/documents/:id — detail + audit trail + metadata 
router.get("/:id", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `
      SELECT
        d.*,
        u.nama AS uploader_nama,
        c.category_name,
        dt.type_name
      FROM documents d
      LEFT JOIN users u
        ON u.id = d.uploaded_by
      LEFT JOIN categories c
        ON c.category_id = d.category_id
      LEFT JOIN document_types dt
        ON dt.type_id = d.type_id
      WHERE d.id = ?
      `,
      [req.params.id]
    );

    if (!doc) {
      return res.status(404).json({
        error: "Dokumen tidak ditemukan",
      });
    }

    // ACCESS DETAIL FOR TEACHER
    try {
      await assertSensitiveAccess(
        pool,
        doc,
        req.user
      );
    } catch (accessErr) {
      return res
        .status(accessErr.status || 403)
        .json({
          error: accessErr.message,
        });
    }

    const [trail] = await pool.query(
      `
      SELECT
        a.*,
        u.nama,
        u.role,
        u.avatar
      FROM audit_trail a
      LEFT JOIN users u
        ON u.id = a.user_id
      WHERE a.document_id = ?
      ORDER BY a.created_at ASC
      `,
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
        `
        SELECT *
        FROM ${metaTableByCategory[doc.category_id]}
        WHERE document_id = ?
        `,
        [doc.id]
      );

      metadata = m || null;
    } else if (doc.category_id === 4) {
      const metaTableByType = {
        10: "incoming_letters",
        11: "outgoing_letters",
        12: "sk_records",
      };

      const tbl = metaTableByType[doc.type_id];

      if (tbl) {
        const [[m]] = await pool.query(
          `SELECT * FROM ${tbl} WHERE document_id = ?`,
          [doc.id]
        );

        metadata = m || null;
      }
    }

    // Catat "Melihat dokumen" ke audit trail (non-blocking)
    pool.query(
      `
      INSERT INTO audit_trail
        (document_id, user_id, action)
      VALUES
        (?, ?, 'Melihat dokumen')
      `,
      [doc.id, req.user.id]
    ).catch(() => {});

    res.json({
      document: doc,
      auditTrail: trail,
      metadata,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/documents/:id/download - URL Supabase Storage bertoken 
router.get("/:id/download", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `
      SELECT
        id,
        judul,
        category_id,
        file_blob_name,
        file_url,
        mime_type,
        original_filename,
        deleted_at,
        is_sensitive,
        uploaded_by
      FROM documents
      WHERE id = ?
      `,
      [req.params.id]
    );

    if (!doc) {
      return res.status(404).json({
        error: "Dokumen tidak ditemukan",
      });
    }

    if (doc.deleted_at) {
      return res.status(410).json({
        error: "Dokumen sudah dihapus",
      });
    }

    if (!doc.file_blob_name) {
      return res.status(422).json({
        error: "File path Supabase tidak ditemukan untuk dokumen ini",
      });
    }

    try {
      await assertSensitiveAccess(
        pool,
        doc,
        req.user
      );
    } catch (accessErr) {
      return res
        .status(accessErr.status || 403)
        .json({
          error: accessErr.message,
        });
    }

    const expiryMinutes =
      Number(req.query.expiry) || 60;

    const fileUrl =
      await getFileUrl(doc.file_blob_name);

    await addAudit(
      pool,
      doc.id,
      req.user.id,
      `Mengunduh dokumen (link ${expiryMinutes} menit)`
    );

    res.json({
      url: fileUrl,
      expiresInSec: expiryMinutes * 60,
      filename:
        doc.original_filename || doc.judul,
      mimeType: doc.mime_type,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/documents/:id/preview 
router.get("/:id/preview", async (req, res, next) => {
  try {
    const [[doc]] = await pool.query(
      `
      SELECT
        id,
        judul,
        category_id,
        file_blob_name,
        file_url,
        mime_type,
        original_filename,
        deleted_at,
        is_sensitive,
        uploaded_by
      FROM documents
      WHERE id = ?
      `,
      [req.params.id]
    );

    if (!doc) {
      return res.status(404).json({
        error: "Dokumen tidak ditemukan",
      });
    }

    if (doc.deleted_at) {
      return res.status(410).json({
        error: "Dokumen sudah dihapus",
      });
    }

    if (!doc.file_blob_name) {
      return res.status(422).json({
        error: "File path Supabase tidak ditemukan untuk dokumen ini",
      });
    }

    try {
      await assertSensitiveAccess(
        pool,
        doc,
        req.user
      );
    } catch (accessErr) {
      return res
        .status(accessErr.status || 403)
        .json({
          error: accessErr.message,
        });
    }

    const fileUrl =
      await getFileUrl(doc.file_blob_name);

    res.json({
      url: fileUrl,
      filename:
        doc.original_filename || doc.judul,
      mimeType: doc.mime_type,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/documents/:id/download-stream 
router.post("/:id/download-stream", async (req, res, next) => {
  try {
    const { password } = req.body || {};

    if (!password || !String(password).trim()) {
      return res.status(400).json({
        error: "Password wajib diisi",
      });
    }

    const [[account]] = await pool.query(
      "SELECT password_hash FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!account) {
      return res.status(404).json({
        error: "Akun tidak ditemukan",
      });
    }

    const passwordMatch = await bcrypt.compare(
      String(password),
      account.password_hash
    );

    if (!passwordMatch) {
      return res.status(403).json({
        error: "Password salah",
      });
    }

    const [[doc]] = await pool.query(
      `
      SELECT
        id,
        judul,
        category_id,
        file_blob_name,
        mime_type,
        original_filename,
        deleted_at,
        is_sensitive,
        uploaded_by
      FROM documents
      WHERE id = ?
      `,
      [req.params.id]
    );

    if (!doc) {
      return res.status(404).json({
        error: "Dokumen tidak ditemukan",
      });
    }

    if (doc.deleted_at) {
      return res.status(410).json({
        error: "Dokumen sudah dihapus",
      });
    }

    if (!doc.file_blob_name) {
      return res.status(422).json({
        error: "File path Supabase tidak ditemukan",
      });
    }

    try {
      await assertSensitiveAccess(
        pool,
        doc,
        req.user
      );
    } catch (accessErr) {
      return res
        .status(accessErr.status || 403)
        .json({
          error: accessErr.message,
        });
    }

    const buffer =
      await downloadFileBuffer(doc.file_blob_name);

    await addAudit(
      pool,
      doc.id,
      req.user.id,
      "Mengunduh dokumen original (stream)"
    );

    const origName =
      doc.original_filename || doc.judul;

    const filename =
      encodeURIComponent(origName);

    res.setHeader(
      "Content-Type",
      doc.mime_type || "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${filename}`
    );

    res.setHeader(
      "Content-Length",
      buffer.length
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.end(buffer);
  } catch (e) {
    next(e);
  }
});

// POST /api/documents - upload dokumen baru 
router.post(
  "/",
  requirePermission("documents.upload"),
  upload.single("file"),
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({
        error: "File wajib diupload (field name: file)",
      });
    }

    const {
      judul,
      category_id,
      type_id,
      folder_id = null,
      tahun_ajaran = null,
      catatan = null,
      metadata = "{}",

      approval_required = "true",

      is_sensitive = "false",
      owner_nips = "[]",

      is_urgent = "false",
    } = req.body;

    if (!judul) {
      return res.status(400).json({
        error: "judul wajib diisi",
      });
    }

    if (!category_id) {
      return res.status(400).json({
        error: "category_id wajib diisi",
      });
    }

    if (!type_id) {
      return res.status(400).json({
        error: "type_id wajib diisi",
      });
    }

    const approvalRequired =
      String(approval_required) !== "false" &&
      approval_required !== "0" &&
      approval_required !== false;

    const sensitiveFlag =
      String(is_sensitive) === "true" ||
      is_sensitive === "1" ||
      is_sensitive === true;

    const urgentFlag =
      String(is_urgent) === "true" ||
      is_urgent === "1" ||
      is_urgent === true;

    let ownerNips = [];

    if (sensitiveFlag) {
      try {
        ownerNips =
          typeof owner_nips === "string"
            ? JSON.parse(owner_nips)
            : owner_nips;
      } catch {
        return res.status(400).json({
          error:
            "Field owner_nips bukan JSON array yang valid",
        });
      }

      if (!Array.isArray(ownerNips)) {
        ownerNips =
          [ownerNips].filter(Boolean);
      }

      ownerNips = [
        ...new Set(
          ownerNips
            .map((n) => String(n).trim())
            .filter(Boolean)
        ),
      ];

      if (ownerNips.length === 0) {
        return res.status(400).json({
          error:
            "NIP pemilik dokumen wajib dipilih untuk dokumen sensitif",
        });
      }
    }

    let ownerUsers = [];

    if (sensitiveFlag) {
      const [rows] = await pool.query(
        `
        SELECT id, nama, nip
        FROM users
        WHERE nip IN (?)
          AND status = 'active'
        `,
        [ownerNips]
      );

      const foundNips =
        new Set(rows.map((r) => r.nip));

      const missing =
        ownerNips.filter(
          (n) => !foundNips.has(n)
        );

      if (missing.length) {
        return res.status(400).json({
          error:
            `NIP pemilik dokumen tidak ditemukan atau bukan user aktif: ${missing.join(", ")}`,
        });
      }

      ownerUsers = rows;
    }

    let parsedMeta;

    try {
      parsedMeta =
        typeof metadata === "string"
          ? JSON.parse(metadata)
          : metadata;
    } catch {
      return res.status(400).json({
        error: "Field metadata bukan JSON valid",
      });
    }

    const DATE_FIELDS = [
      "tanggalLahir",
      "tanggalSurat",
      "tanggalDiterima",
      "tanggalSK",
    ];

    if (
      parsedMeta &&
      typeof parsedMeta === "object"
    ) {
      for (const field of DATE_FIELDS) {
        if (
          parsedMeta[field] === undefined
        ) {
          continue;
        }

        const { value, error } =
          normalizeDateToISO(
            parsedMeta[field]
          );

        if (error) {
          return res.status(400).json({
            error: `${field}: ${error}`,
          });
        }

        parsedMeta[field] = value;
      }
    }

    // Upload ke Supabase terlebih dahulu
    let blob;

    try {
      blob = await uploadFile(
        req.file,
        category_id
      );
    } catch (storageErr) {
      if (storageErr.status) {
        return res
          .status(storageErr.status)
          .json({
            error: storageErr.message,
          });
      }

      console.error(
        "[Upload] Supabase upload gagal:",
        storageErr.stack ||
          storageErr.message
      );

      return res.status(502).json({
        error:
          "Gagal mengunggah file ke Supabase Storage. Coba lagi beberapa saat.",
        detail:
          process.env.NODE_ENV !==
          "production"
            ? storageErr.message
            : undefined,
      });
    }

    const conn =
      await pool.getConnection();

    try {
      await conn.beginTransaction();

      const nomor =
        await generateDocumentNumber(
          conn,
          category_id,
          type_id
        );

      const initialStatus =
        approvalRequired
          ? "Menunggu"
          : "Diarsipkan";

      const approvalStatus =
        approvalRequired
          ? "pending"
          : "not_required";

      const primaryOwner =
        ownerUsers[0] || null;

      const [ins] = await conn.query(
        `
        INSERT INTO documents
        (
          judul,
          nomor_dokumen,
          category_id,
          type_id,
          folder_id,
          tahun_ajaran,
          status,
          versi,
          uploaded_by,
          file_url,
          file_blob_name,
          file_size,
          mime_type,
          original_filename,
          catatan,
          approval_required,
          is_sensitive,
          owner_user_id,
          owner_nip,
          approval_status,
          is_urgent
        )
        VALUES
        (
          ?, ?, ?, ?, ?, ?,
          ?, 1, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
        `,
        [
          judul,
          nomor,
          category_id,
          type_id,
          folder_id || null,
          tahun_ajaran || null,
          initialStatus,
          req.user.id,
          blob.url,
          blob.blobName,
          blob.size,
          blob.mimeType,
          req.file.originalname,
          catatan || null,
          approvalRequired ? 1 : 0,
          sensitiveFlag ? 1 : 0,
          primaryOwner
            ? primaryOwner.id
            : null,
          primaryOwner
            ? primaryOwner.nip
            : null,
          approvalStatus,
          urgentFlag ? 1 : 0,
        ]
      );

      const docId = ins.insertId;

      if (
        sensitiveFlag &&
        ownerUsers.length
      ) {
        await conn.query(
          `
          INSERT INTO document_owners
            (document_id, user_id, nip)
          VALUES ?
          `,
          [
            ownerUsers.map((u) => [
              docId,
              u.id,
              u.nip,
            ]),
          ]
        );
      }

      await insertMetadata(
        conn,
        docId,
        Number(category_id),
        Number(type_id),
        parsedMeta
      );

      await addAudit(
        conn,
        docId,
        req.user.id,
        `Mengunggah dokumen (${req.file.originalname}, ${(blob.size / 1024).toFixed(1)} KB, ${blob.mimeType})`,
        null,
        null,
        {
          status: initialStatus,
          versi: 1,
          filename:
            req.file.originalname,
          approvalRequired,
          isSensitive: sensitiveFlag,
          isUrgent: urgentFlag,
        }
      );

      if (approvalRequired) {
        const [aprIns] =
          await conn.query(
            `
            INSERT INTO approval_requests
              (
                document_id,
                requester_id,
                status,
                requester_note,
                requested_at
              )
            VALUES
              (?, ?, 'pending', NULL, NOW())
            `,
            [docId, req.user.id]
          );

        const requestId =
          aprIns.insertId;

        await addAudit(
          conn,
          docId,
          req.user.id,
          "Mengajukan persetujuan dokumen",
          requestId,
          null,
          {
            status: "Menunggu",
          }
        );

        await conn.query(
          `
          INSERT INTO notifications
            (
              user_id,
              message,
              type,
              document_id
            )
          SELECT
            u.id,
            CONCAT(
              'Dokumen baru menunggu persetujuan: ',
              ?
            ),
            'upload',
            ?
          FROM users u
          WHERE
            u.role IN (
              'Kepala Sekolah',
              'Operator/TU'
            )
            AND u.status = 'active'
            AND u.id != ?
          `,
          [
            judul,
            docId,
            req.user.id,
          ]
        );

        const [approverRows] = await conn.query(
          `SELECT id FROM users
           WHERE role IN ('Kepala Sekolah', 'Operator/TU')
             AND status = 'active'
             AND id != ?`,
          [req.user.id]
        );
        await notifyEmailForUsers(
          conn,
          approverRows.map((r) => r.id),
          `Dokumen baru menunggu persetujuan: ${judul}`,
          "Menunggu Persetujuan"
        );
      } else {
        await addAudit(
          conn,
          docId,
          req.user.id,
          "Dokumen langsung diarsipkan otomatis (tanpa approval Kepsek)",
          null,
          {
            status: "Menunggu",
          },
          {
            status: "Diarsipkan",
          }
        );
      }

      await conn.commit();

      res.status(201).json({
        id: docId,
        nomor_dokumen: nomor,
        file_url: blob.url,
        file_blob_name: blob.blobName,
        file_size: blob.size,
        mime_type: blob.mimeType,
        status: initialStatus,
        approval_required:
          approvalRequired,
        is_sensitive:
          sensitiveFlag,
        is_urgent:
          urgentFlag,
      });
    } catch (dbErr) {
      await conn.rollback();

      console.error(
        "[Upload] DB error setelah Supabase upload — rolling back file:",
        blob?.blobName
      );

      if (blob?.blobName) {
        await deleteFile(
          blob.blobName
        ).catch((e) =>
          console.warn(
            "[Upload] Gagal hapus orphan file:",
            e.message
          )
        );
      }

      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// PATCH /api/documents/:id/file - replace file 
router.patch(
  "/:id/file",
  requirePermission("documents.edit"),
  upload.single("file"),
  async (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({
        error:
          "File baru wajib diupload (field name: file)",
      });
    }

    const [[doc]] =
      await pool.query(
        `
        SELECT
          id,
          judul,
          category_id,
          file_blob_name,
          versi,
          deleted_at
        FROM documents
        WHERE id = ?
        `,
        [req.params.id]
      );

    if (!doc) {
      return res.status(404).json({
        error:
          "Dokumen tidak ditemukan",
      });
    }

    if (doc.deleted_at) {
      return res.status(410).json({
        error:
          "Dokumen sudah dihapus",
      });
    }

    let newBlob;

    try {
      newBlob =
        await uploadFile(
          req.file,
          doc.category_id
        );
    } catch (storageErr) {
      if (storageErr.status) {
        return res
          .status(storageErr.status)
          .json({
            error:
              storageErr.message,
          });
      }

      return res.status(502).json({
        error:
          "Gagal mengunggah file ke Supabase Storage.",
        detail:
          storageErr.message,
      });
    }

    const conn =
      await pool.getConnection();

    try {
      await conn.beginTransaction();

      const oldBlobName =
        doc.file_blob_name;

      const newVersi =
        (doc.versi || 1) + 1;

      await conn.query(
        `
        UPDATE documents
        SET
          file_url = ?,
          file_blob_name = ?,
          file_size = ?,
          mime_type = ?,
          original_filename = ?,
          versi = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [
          newBlob.url,
          newBlob.blobName,
          newBlob.size,
          newBlob.mimeType,
          req.file.originalname,
          newVersi,
          doc.id,
        ]
      );

      await addAudit(
        conn,
        doc.id,
        req.user.id,
        `Mengganti file (versi ${newVersi}: ${req.file.originalname}, ${(newBlob.size / 1024).toFixed(1)} KB)`,
        null,
        {
          versi: doc.versi,
          filename:
            doc.file_blob_name,
        },
        {
          versi: newVersi,
          filename:
            req.file.originalname,
        }
      );

      await conn.commit();

      if (oldBlobName) {
        await deleteFile(
          oldBlobName
        );
      }

      res.json({
        message:
          "File berhasil diganti",
        versi: newVersi,
        file_url: newBlob.url,
      });
    } catch (dbErr) {
      await conn.rollback();

      if (newBlob?.blobName) {
        await deleteFile(
          newBlob.blobName
        ).catch(() => {});
      }

      next(dbErr);
    } finally {
      conn.release();
    }
  }
);

// PATCH /api/documents/:id - edit basis metadata  
router.patch(
  "/:id",
  requirePermission("documents.edit"),
  async (req, res, next) => {
    const conn =
      await pool.getConnection();

    const [[oldDoc]] =
      await conn.query(
        `
        SELECT
          judul,
          catatan,
          folder_id,
          tahun_ajaran
        FROM documents
        WHERE id = ?
        `,
        [req.params.id]
      );

    try {
      const {
        judul,
        catatan,
        folder_id,
        tahun_ajaran,
      } = req.body;

      const [r] =
        await conn.query(
          `
          UPDATE documents
          SET
            judul =
              COALESCE(?, judul),
            catatan =
              COALESCE(?, catatan),
            folder_id =
              COALESCE(?, folder_id),
            tahun_ajaran =
              COALESCE(?, tahun_ajaran),
            updated_at = NOW()
          WHERE
            id = ?
            AND deleted_at IS NULL
          `,
          [
            judul || null,
            catatan || null,
            folder_id || null,
            tahun_ajaran || null,
            req.params.id,
          ]
        );

      if (!r.affectedRows) {
        return res.status(404).json({
          error:
            "Dokumen tidak ditemukan atau sudah dihapus",
        });
      }

      await addAudit(
        conn,
        req.params.id,
        req.user.id,
        "Mengedit metadata dokumen",
        null,
        oldDoc,
        {
          judul:
            judul !== undefined
              ? judul
              : oldDoc.judul,

          catatan:
            catatan !== undefined
              ? catatan
              : oldDoc.catatan,

          folder_id:
            folder_id !== undefined
              ? folder_id
              : oldDoc.folder_id,

          tahun_ajaran:
            tahun_ajaran !== undefined
              ? tahun_ajaran
              : oldDoc.tahun_ajaran,
        }
      );

      res.json({
        message:
          "Dokumen diperbarui",
      });
    } catch (e) {
      next(e);
    } finally {
      conn.release();
    }
  }
);

// ── POST /api/documents/:id/approve ──────────────────────────────────────────
router.post(
  "/:id/approve",
  requirePermission("documents.approve"),
  async (req, res, next) => {
    const conn =
      await pool.getConnection();

    try {
      await conn.beginTransaction();

      const {
        comment = "",
      } = req.body || {};

      const [r] =
        await conn.query(
          `
          UPDATE documents
          SET
            status = 'Diarsipkan',
            approval_status = 'approved',
            approved_by = ?,
            approved_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ?
            AND status = 'Menunggu'
          `,
          [
            req.user.id,
            req.params.id,
          ]
        );

      if (!r.affectedRows) {
        await conn.rollback();

        return res.status(400).json({
          error:
            "Dokumen tidak dalam status Menunggu",
        });
      }

      await conn.query(
        `
        UPDATE approval_requests
        SET
          status = 'approved',
          approver_id = ?,
          approver_note = ?,
          decided_at = NOW()
        WHERE
          document_id = ?
          AND status = 'pending'
        `,
        [
          req.user.id,
          comment || null,
          req.params.id,
        ]
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
          status: "Menunggu",
        },
        {
          status: "Disetujui",
          catatan:
            comment || null,
        }
      );

      await addAudit(
        conn,
        req.params.id,
        req.user.id,
        "Dokumen otomatis diarsipkan setelah persetujuan",
        null,
        {
          status: "Disetujui",
        },
        {
          status: "Diarsipkan",
        }
      );

      await conn.query(
        `
        INSERT INTO notifications
          (
            user_id,
            message,
            type,
            document_id
          )
        SELECT
          uploaded_by,
          CONCAT(
            'Dokumen "',
            judul,
            '" telah disetujui dan diarsipkan'
          ),
          'approval',
          id
        FROM documents
        WHERE id = ?
        `,
        [req.params.id]
      );

      const [[approvedDoc]] = await conn.query(
        "SELECT uploaded_by, judul FROM documents WHERE id = ?",
        [req.params.id]
      );
      if (approvedDoc) {
        await notifyEmailForUsers(
          conn,
          [approvedDoc.uploaded_by],
          `Dokumen "${approvedDoc.judul}" telah disetujui dan diarsipkan`,
          "Dokumen Disetujui"
        );
      }

      await conn.commit();

      res.json({
        message:
          "Dokumen disetujui",
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  }
);

// ── POST /api/documents/:id/reject ───────────────────────────────────────────
router.post(
  "/:id/reject",
  requirePermission("documents.reject"),
  async (req, res, next) => {
    const conn =
      await pool.getConnection();

    try {
      await conn.beginTransaction();

      const { reason } = req.body;

      if (!reason) {
        await conn.rollback();

        return res.status(400).json({
          error:
            "reason wajib diisi",
        });
      }

      const [r] =
        await conn.query(
          `
          UPDATE documents
          SET
            status = 'Ditolak',
            catatan = ?,
            approval_status = 'rejected',
            approved_by = ?,
            approved_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ?
            AND status = 'Menunggu'
          `,
          [
            reason,
            req.user.id,
            req.params.id,
          ]
        );

      if (!r.affectedRows) {
        await conn.rollback();

        return res.status(400).json({
          error:
            "Dokumen tidak dalam status Menunggu",
        });
      }

      await conn.query(
        `
        UPDATE approval_requests
        SET
          status = 'rejected',
          approver_id = ?,
          approver_note = ?,
          decided_at = NOW()
        WHERE
          document_id = ?
          AND status = 'pending'
        `,
        [
          req.user.id,
          reason,
          req.params.id,
        ]
      );

      await addAudit(
        conn,
        req.params.id,
        req.user.id,
        `Menolak dokumen: ${reason}`,
        null,
        {
          status: "Menunggu",
        },
        {
          status: "Ditolak",
          alasan: reason,
        }
      );

      await conn.query(
        `
        INSERT INTO notifications
          (
            user_id,
            message,
            type,
            document_id
          )
        SELECT
          uploaded_by,
          CONCAT(
            'Dokumen "',
            judul,
            '" telah ditolak'
          ),
          'rejection',
          id
        FROM documents
        WHERE id = ?
        `,
        [req.params.id]
      );

      const [[rejectedDoc]] = await conn.query(
        "SELECT uploaded_by, judul FROM documents WHERE id = ?",
        [req.params.id]
      );
      if (rejectedDoc) {
        await notifyEmailForUsers(
          conn,
          [rejectedDoc.uploaded_by],
          `Dokumen "${rejectedDoc.judul}" ditolak. Alasan: ${reason}`,
          "Dokumen Ditolak"
        );
      }

      await conn.commit();

      res.json({
        message:
          "Dokumen ditolak",
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  }
);

// ── DELETE /api/documents/:id — soft delete ──────────────────────────────────
router.delete(
  "/:id",
  requirePermission("documents.delete"),
  async (req, res, next) => {
    try {
      const [r] =
        await pool.query(
          `
          UPDATE documents
          SET deleted_at = NOW()
          WHERE
            id = ?
            AND deleted_at IS NULL
          `,
          [req.params.id]
        );

      if (!r.affectedRows) {
        return res.status(404).json({
          error:
            "Dokumen tidak ditemukan atau sudah dihapus",
        });
      }

      await addAudit(
        pool,
        req.params.id,
        req.user.id,
        "Memindahkan dokumen ke tempat sampah",
        null,
        {
          deleted: false,
        },
        {
          deleted: true,
        }
      );

      res.json({
        message:
          "Dokumen dipindahkan ke tempat sampah",
      });
    } catch (e) {
      next(e);
    }
  }
);

// ── POST /api/documents/:id/restore ──────────────────────────────────────────
router.post(
  "/:id/restore",
  requirePermission("documents.delete"),
  async (req, res, next) => {
    try {
      const [[doc]] =
        await pool.query(
          `
          SELECT
            id,
            file_blob_name
          FROM documents
          WHERE id = ?
          `,
          [req.params.id]
        );

      if (!doc) {
        return res.status(404).json({
          error:
            "Dokumen tidak ditemukan",
        });
      }

      if (doc.file_blob_name) {
        const exists =
          await checkFileExists(
            doc.file_blob_name
          );

        if (!exists) {
          return res.status(409).json({
            error:
              "File dokumen tidak ditemukan di Supabase Storage, tidak bisa dipulihkan",
          });
        }
      }

      await pool.query(
        `
        UPDATE documents
        SET deleted_at = NULL
        WHERE id = ?
        `,
        [req.params.id]
      );

      await addAudit(
        pool,
        req.params.id,
        req.user.id,
        "Memulihkan dokumen dari tempat sampah",
        null,
        {
          deleted: true,
        },
        {
          deleted: false,
        }
      );

      res.json({
        message:
          "Dokumen dipulihkan",
      });
    } catch (e) {
      next(e);
    }
  }
);

// ── DELETE /api/documents/:id/permanent ──────────────────────────────────────
router.delete(
  "/:id/permanent",
  requirePermission("documents.delete"),
  async (req, res, next) => {
    try {
      const [[doc]] =
        await pool.query(
          `
          SELECT file_blob_name
          FROM documents
          WHERE id = ?
          `,
          [req.params.id]
        );

      if (!doc) {
        return res.status(404).json({
          error:
            "Dokumen tidak ditemukan",
        });
      }

      if (doc.file_blob_name) {
        await deleteFile(
          doc.file_blob_name
        );
      }

      await pool.query(
        `
        DELETE FROM documents
        WHERE id = ?
        `,
        [req.params.id]
      );

      res.json({
        message:
          "Dokumen dihapus permanen",
      });
    } catch (e) {
      next(e);
    }
  }
);

// ── insertMetadata ────────────────────────────────────────────────────────────
async function insertMetadata(
  conn,
  docId,
  categoryId,
  typeId,
  meta
) {
  if (
    !meta ||
    typeof meta !== "object"
  ) {
    return;
  }

  if (categoryId === 1) {
    await conn.query(
      `
      INSERT INTO student_records
      (
        document_id,
        nama_siswa,
        nis,
        nisn,
        kelas,
        tahun_ajaran,
        tempat_lahir,
        tanggal_lahir,
        jenis_kelamin,
        nama_orang_tua,
        no_hp_orang_tua
      )
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        docId,
        meta.namaSiswa || null,
        meta.nis || null,
        meta.nisn || null,
        meta.kelas || null,
        meta.tahunAjaran || null,
        meta.tempatLahir || null,
        meta.tanggalLahir || null,
        meta.jenisKelamin || null,
        meta.namaOrangTua || null,
        meta.noHpOrangTua || null,
      ]
    );
  } else if (categoryId === 2) {
    await conn.query(
      `
      INSERT INTO teacher_records
      (
        document_id,
        nama_guru,
        nip,
        nuptk,
        mata_pelajaran,
        pendidikan_terakhir,
        status_kepegawaian
      )
      VALUES
      (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        docId,
        meta.namaGuru || null,
        meta.nip || null,
        meta.nuptk || null,
        meta.mataPelajaran || null,
        meta.pendidikanTerakhir || null,
        meta.statusKepegawaian || null,
      ]
    );
  } else if (categoryId === 3) {
    await conn.query(
      `
      INSERT INTO inventory_items
      (
        document_id,
        kode_barang,
        nama_barang,
        jumlah,
        tahun_pengadaan,
        kondisi,
        lokasi
      )
      VALUES
      (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        docId,
        meta.kodeBarang || null,
        meta.namaBarang || null,
        meta.jumlah || null,
        meta.tahunPengadaan || null,
        meta.kondisi || null,
        meta.lokasi || null,
      ]
    );
  } else if (categoryId === 4) {
    if (typeId === 10) {
      await conn.query(
        `
        INSERT INTO incoming_letters
        (
          document_id,
          nomor_agenda,
          nomor_surat,
          tanggal_surat,
          tanggal_diterima,
          pengirim,
          perihal
        )
        VALUES
        (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          docId,
          meta.nomorAgenda || null,
          meta.nomorSurat || null,
          meta.tanggalSurat || null,
          meta.tanggalDiterima || null,
          meta.pengirim || null,
          meta.perihal || null,
        ]
      );
    } else if (typeId === 11) {
      await conn.query(
        `
        INSERT INTO outgoing_letters
        (
          document_id,
          nomor_agenda,
          nomor_surat,
          tanggal_surat,
          tujuan,
          perihal,
          penandatangan
        )
        VALUES
        (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          docId,
          meta.nomorAgenda || null,
          meta.nomorSurat || null,
          meta.tanggalSurat || null,
          meta.tujuan || null,
          meta.perihal || null,
          meta.penandatangan || null,
        ]
      );
    } else if (typeId === 12) {
      await conn.query(
        `
        INSERT INTO sk_records
        (
          document_id,
          nomor_sk,
          tanggal_sk,
          tentang,
          penandatangan
        )
        VALUES
        (?, ?, ?, ?, ?)
        `,
        [
          docId,
          meta.nomorSK || null,
          meta.tanggalSK || null,
          meta.tentang || null,
          meta.penandatangan || null,
        ]
      );
    }
  }
}

module.exports = router;