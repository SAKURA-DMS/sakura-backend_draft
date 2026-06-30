const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// GET /api/categories  —  fetch all categories & document types
router.get("/", async (_req, res, next) => {
  try {
    const [cats]  = await pool.query("SELECT * FROM categories ORDER BY category_id");
    const [types] = await pool.query("SELECT * FROM document_types ORDER BY type_id");
    res.json({ categories: cats, documentTypes: types });
  } catch (e) { next(e); }
});

// POST /api/categories/custom  —  add a new category (master data)
router.post("/custom", async (req, res, next) => {
  try {
    const { category_name } = req.body;
    if (!category_name?.trim()) {
      return res.status(400).json({ error: "category_name wajib diisi" });
    }
    const name = category_name.trim();

    // Prevent duplicates (case-insensitive)
    const [existing] = await pool.query(
      "SELECT category_id FROM categories WHERE LOWER(category_name) = LOWER(?)",
      [name]
    );
    if (existing.length > 0) {
      return res.json({ category: existing[0], already_exists: true });
    }

    const [result] = await pool.query(
      "INSERT INTO categories (category_name) VALUES (?)",
      [name]
    );
    const newCategory = { category_id: result.insertId, category_name: name };
    res.status(201).json({ category: newCategory });
  } catch (e) { next(e); }
});

// POST /api/categories/custom-type  —  add a new document type to a category (master data)
router.post("/custom-type", async (req, res, next) => {
  try {
    const { type_name, category_id } = req.body;
    if (!type_name?.trim())  return res.status(400).json({ error: "type_name wajib diisi" });
    if (!category_id)        return res.status(400).json({ error: "category_id wajib diisi" });

    const name = type_name.trim();
    const catId = Number(category_id);

    // Verify category exists
    const [cats] = await pool.query("SELECT category_id FROM categories WHERE category_id = ?", [catId]);
    if (cats.length === 0) return res.status(404).json({ error: "Kategori tidak ditemukan" });

    // Prevent duplicates within same category
    const [existing] = await pool.query(
      "SELECT type_id, category_id, type_name, code_prefix FROM document_types WHERE category_id = ? AND LOWER(type_name) = LOWER(?)",
      [catId, name]
    );
    if (existing.length > 0) return res.json({ type: existing[0], already_exists: true });

    const [result] = await pool.query(
      "INSERT INTO document_types (category_id, type_name, code_prefix) VALUES (?, ?, 'LNR')",
      [catId, name]
    );
    const newType = { type_id: result.insertId, category_id: catId, type_name: name, code_prefix: "LNR" };
    res.status(201).json({ type: newType });
  } catch (e) { next(e); }
});

module.exports = router;