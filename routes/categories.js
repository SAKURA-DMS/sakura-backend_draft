const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { logActivity } = require("../utils/auditLog");

const router = express.Router();
router.use(authRequired);

// GET /api/categories 
router.get("/", async (_req, res, next) => {
  try {
    const [cats]  = await pool.query("SELECT * FROM categories ORDER BY category_id");
    const [types] = await pool.query("SELECT * FROM document_types ORDER BY type_id");
    res.json({ categories: cats, documentTypes: types });
  } catch (e) { next(e); }
});

// POST /api/categories/custom 
router.post("/custom", async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { category_name } = req.body;
    if (!category_name?.trim()) {
      conn.release();
      return res.status(400).json({ error: "category_name wajib diisi" });
    }
    const name = category_name.trim();

    await conn.beginTransaction();

    const [existing] = await conn.query(
      "SELECT category_id FROM categories WHERE LOWER(category_name) = LOWER(?)",
      [name]
    );

    let category;
    let alreadyExists = false;

    if (existing.length > 0) {
      alreadyExists = true;
      const [[cat]] = await conn.query("SELECT * FROM categories WHERE category_id = ?", [existing[0].category_id]);
      category = cat;
    } else {
      const [result] = await conn.query(
        "INSERT INTO categories (category_name, code_prefix) VALUES (?, 'OTH')",
        [name]
      );
      category = { category_id: result.insertId, category_name: name, code_prefix: "OTH" };
    }

    const [[existingFolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
      [category.category_id]
    );

    let folderId = existingFolder ? existingFolder.folder_id : null;

    if (!folderId) {
      const [[row]] = await conn.query("SELECT COALESCE(MAX(folder_id), 0) AS maxId FROM folders FOR UPDATE");
      folderId = row.maxId + 1;
      await conn.query(
        `INSERT INTO folders (folder_id, folder_name, parent_id, category_id, type_id, description, is_custom)
         VALUES (?, ?, NULL, ?, NULL, ?, 1)`,
        [folderId, name, `Folder kategori "${name}" (dibuat otomatis dari Upload Dokumen).`]
      );
    }

    await conn.commit();

    if (!alreadyExists) {
      logActivity(pool, {
        documentId: null,
        userId: req.user.id,
        action: `Membuat kategori baru "${name}"`,
        newValue: { category_id: category.category_id, category_name: name, folder_id: folderId },
      }).catch((e) => console.error("[categories:custom] Gagal mencatat audit log:", e.message));
    }

    res.status(alreadyExists ? 200 : 201).json({
      category: { ...category, folder_id: folderId },
      already_exists: alreadyExists,
    });
  } catch (e) {
    await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn.release();
  }
});

// POST /api/categories/custom-type
router.post("/custom-type", async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { type_name, category_id } = req.body;
    if (!type_name?.trim())  { conn.release(); return res.status(400).json({ error: "type_name wajib diisi" }); }
    if (!category_id)        { conn.release(); return res.status(400).json({ error: "category_id wajib diisi" }); }

    const name = type_name.trim();
    const catId = Number(category_id);

    await conn.beginTransaction();

    const [cats] = await conn.query("SELECT category_id, category_name FROM categories WHERE category_id = ?", [catId]);
    if (cats.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: "Kategori tidak ditemukan" });
    }
    const categoryName = cats[0].category_name;

    const [existingType] = await conn.query(
      "SELECT type_id, category_id, type_name, code_prefix FROM document_types WHERE category_id = ? AND LOWER(type_name) = LOWER(?)",
      [catId, name]
    );

    let type;
    let alreadyExists = false;

    if (existingType.length > 0) {
      alreadyExists = true;
      type = existingType[0];
    } else {
      const [result] = await conn.query(
        "INSERT INTO document_types (category_id, type_name, code_prefix) VALUES (?, ?, 'OTH')",
        [catId, name]
      );
      type = { type_id: result.insertId, category_id: catId, type_name: name, code_prefix: "OTH" };
    }

    let [[parentFolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id IS NULL AND parent_id IS NULL LIMIT 1",
      [catId]
    );

    if (!parentFolder) {
      const [[row]] = await conn.query("SELECT COALESCE(MAX(folder_id), 0) AS maxId FROM folders FOR UPDATE");
      const newParentId = row.maxId + 1;
      await conn.query(
        `INSERT INTO folders (folder_id, folder_name, parent_id, category_id, type_id, description, is_custom)
         VALUES (?, ?, NULL, ?, NULL, ?, 1)`,
        [newParentId, categoryName, `Folder kategori "${categoryName}" (dibuat otomatis).`]
      );
      parentFolder = { folder_id: newParentId };
    }

    const [[existingSubfolder]] = await conn.query(
      "SELECT folder_id FROM folders WHERE category_id = ? AND type_id = ? LIMIT 1",
      [catId, type.type_id]
    );

    let folderId = existingSubfolder ? existingSubfolder.folder_id : null;

    if (!folderId) {
      const [[row]] = await conn.query("SELECT COALESCE(MAX(folder_id), 0) AS maxId FROM folders FOR UPDATE");
      folderId = row.maxId + 1;
      await conn.query(
        `INSERT INTO folders (folder_id, folder_name, parent_id, category_id, type_id, description, is_custom)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [folderId, name, parentFolder.folder_id, catId, type.type_id, `Folder jenis dokumen "${name}" (dibuat otomatis dari Upload Dokumen).`]
      );
    }

    await conn.commit();

    if (!alreadyExists) {
      logActivity(pool, {
        documentId: null,
        userId: req.user.id,
        action: `Membuat jenis dokumen baru "${name}" pada kategori "${categoryName}"`,
        newValue: { type_id: type.type_id, type_name: name, category_id: catId, folder_id: folderId },
      }).catch((e) => console.error("[categories:custom-type] Gagal mencatat audit log:", e.message));
    }

    res.status(alreadyExists ? 200 : 201).json({
      type: { ...type, folder_id: folderId },
      already_exists: alreadyExists,
    });
  } catch (e) {
    await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn.release();
  }
});

module.exports = router;