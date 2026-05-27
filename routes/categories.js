const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// GET /api/categories
router.get("/", async (_req, res, next) => {
  try {
    const [cats] = await pool.query("SELECT * FROM categories ORDER BY category_id");
    const [types] = await pool.query("SELECT * FROM document_types ORDER BY type_id");
    res.json({ categories: cats, documentTypes: types });
  } catch (e) { next(e); }
});

module.exports = router;
