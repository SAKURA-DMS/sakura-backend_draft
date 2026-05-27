const pool = require("../config/db");

// Cek apakah role user saat ini punya permission tertentu.
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const role = req.user?.role;
      if (!role) return res.status(401).json({ error: "Unauthorized" });

      const [rows] = await pool.query(
        `SELECT 1 FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE rp.role_name = ? AND p.permission_key = ? LIMIT 1`,
        [role, permission]
      );
      if (!rows.length) {
        return res.status(403).json({ error: `Akses ditolak: butuh permission '${permission}'` });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Akses ditolak" });
    }
    next();
  };
}

module.exports = { requirePermission, requireRole };
