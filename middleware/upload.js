const multer = require("multer");

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 25);

const storage = multer.memoryStorage();

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/octet-stream",      
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/msword",                // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel",          // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
]);

const ALLOWED_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx", ".xls", ".xlsx"]);

const fileFilter = (_req, file, cb) => {
  const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
  const mimeOk = ALLOWED_MIME.has(file.mimetype);
  const extOk  = ALLOWED_EXT.has(ext);

  if (mimeOk || extOk) {
    cb(null, true);
  } else {
    const err = new Error(`Tipe file tidak diizinkan: ${file.mimetype} (${ext})`);
    err.status = 415;
    cb(err);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_MB * 1024 * 1024,
    files: 1,
  },
});

module.exports = upload;
module.exports.ALLOWED_MIME = ALLOWED_MIME;
module.exports.MAX_MB = MAX_MB;
