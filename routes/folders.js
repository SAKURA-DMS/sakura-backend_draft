const express = require("express");
const pool = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { requirePermission } = require("../middleware/rbac");
const { logActivity } = require("../utils/auditLog");

const router = express.Router();
router.use(authRequired);

// GET /api/folders
router.get("/", async (_req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM folders ORDER BY folder_id");
    res.json({ folders: rows });
  } catch (e) { next(e); }
});

// POST /api/folders
router.post("/", requirePermission("folders.manage"), async (req, res, next) => {
  try {
    const { folder_name, parent_id = null, category_id = null, type_id = null, description = "" } = req.body;
    if (!folder_name) return res.status(400).json({ error: "folder_name wajib diisi" });
    const [result] = await pool.query(
      `INSERT INTO folders (folder_name, parent_id, category_id, type_id, description, is_custom)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [folder_name, parent_id, category_id, type_id, description]
    );

    logActivity(pool, {
      documentId: null,
      userId: req.user.id,
      action: `Membuat folder "${folder_name}"`,
      newValue: { folder_id: result.insertId, folder_name, parent_id },
    }).catch((e) => console.error("[folders:create] Gagal mencatat audit log:", e.message));

    res.status(201).json({ folder_id: result.insertId });
  } catch (e) { next(e); }
});

// PATCH /api/folders/:id
router.patch("/:id", requirePermission("folders.manage"), async (req, res, next) => {
  try {
    const { folder_name, description } = req.body;

    const [[oldFolder]] = await pool.query(
      "SELECT folder_name, description FROM folders WHERE folder_id = ?",
      [req.params.id]
    );

    await pool.query(
      "UPDATE folders SET folder_name = COALESCE(?, folder_name), description = COALESCE(?, description) WHERE folder_id = ? AND is_custom = 1",
      [folder_name || null, description || null, req.params.id]
    );

    if (oldFolder) {
      logActivity(pool, {
        documentId: null,
        userId: req.user.id,
        action: `Mengubah folder "${oldFolder.folder_name}"`,
        oldValue: oldFolder,
        newValue: {
          folder_name: folder_name || oldFolder.folder_name,
          description: description || oldFolder.description,
        },
      }).catch((e) => console.error("[folders:patch] Gagal mencatat audit log:", e.message));
    }

    res.json({ message: "Folder diperbarui" });
  } catch (e) { next(e); }
});

// DELETE /api/folders/:id
router.delete("/:id", requirePermission("folders.manage"), async (req, res, next) => {
  try {
    const [[oldFolder]] = await pool.query(
      "SELECT folder_name FROM folders WHERE folder_id = ?",
      [req.params.id]
    );

    await pool.query("DELETE FROM folders WHERE folder_id = ? AND is_custom = 1", [req.params.id]);

    if (oldFolder) {
      logActivity(pool, {
        documentId: null,
        userId: req.user.id,
        action: `Menghapus folder "${oldFolder.folder_name}"`,
        oldValue: oldFolder,
      }).catch((e) => console.error("[folders:delete] Gagal mencatat audit log:", e.message));
    }

    res.json({ message: "Folder dihapus" });
  } catch (e) { next(e); }
});

module.exports = router;