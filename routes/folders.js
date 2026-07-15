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
// Mendukung rename/edit deskripsi (folder_name, description) DAN memindahkan
// folder ke parent lain (parent_id) — dipakai oleh fitur "Pindahkan Folder".
// parent_id sengaja dibedakan dari undefined vs null: null berarti "pindahkan
// ke root", sedangkan tidak dikirim sama sekali berarti "jangan diubah".
router.patch("/:id", requirePermission("folders.manage"), async (req, res, next) => {
  try {
    const folderId = req.params.id;
    const { folder_name, description, parent_id } = req.body;

    const [[oldFolder]] = await pool.query(
      "SELECT folder_id, folder_name, description, parent_id FROM folders WHERE folder_id = ?",
      [folderId]
    );

    if (!oldFolder) {
      return res.status(404).json({ error: "Folder tidak ditemukan" });
    }

    // Cegah folder dipindahkan ke dirinya sendiri.
    if (parent_id !== undefined && Number(parent_id) === Number(folderId)) {
      return res.status(400).json({ error: "Folder tidak bisa dipindahkan ke dirinya sendiri" });
    }

    const fields = [];
    const values = [];

    if (folder_name !== undefined && folder_name !== null && folder_name !== "") {
      fields.push("folder_name = ?");
      values.push(folder_name);
    }
    if (description !== undefined && description !== null) {
      fields.push("description = ?");
      values.push(description);
    }
    if (parent_id !== undefined) {
      fields.push("parent_id = ?");
      values.push(parent_id === null || parent_id === "" ? null : parent_id);
    }

    if (fields.length === 0) {
      return res.json({ message: "Tidak ada perubahan" });
    }

    values.push(folderId);
    await pool.query(
      `UPDATE folders SET ${fields.join(", ")} WHERE folder_id = ? AND is_custom = 1`,
      values
    );

    const actionLabel = parent_id !== undefined && fields.length === 1
      ? `Memindahkan folder "${oldFolder.folder_name}"`
      : `Mengubah folder "${oldFolder.folder_name}"`;

    logActivity(pool, {
      documentId: null,
      userId: req.user.id,
      action: actionLabel,
      oldValue: oldFolder,
      newValue: {
        folder_name: folder_name || oldFolder.folder_name,
        description: description !== undefined ? description : oldFolder.description,
        parent_id: parent_id !== undefined ? parent_id : oldFolder.parent_id,
      },
    }).catch((e) => console.error("[folders:patch] Gagal mencatat audit log:", e.message));

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