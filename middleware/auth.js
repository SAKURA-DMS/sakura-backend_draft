const jwt = require("jsonwebtoken");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token tidak ditemukan" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; 
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token tidak valid atau kedaluwarsa" });
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, nama: user.nama },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
}

module.exports = { authRequired, signToken };
