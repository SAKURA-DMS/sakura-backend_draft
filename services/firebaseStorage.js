const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

const MAX_RETRY = 3;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "application/csv",
  "text/xml",
  "application/xml",
  "application/json",
]);
const ALLOWED_EXT = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".xml",
  ".json",
]);

let bucket = null;

function normalizePrivateKey(key) {
  return key ? key.replace(/\\n/g, "\n") : key;
}

function getCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    });
  }

  return admin.credential.applicationDefault();
}

function getBucketName() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error("FIREBASE_STORAGE_BUCKET belum diset di .env");
  return bucketName.replace(/^gs:\/\//, "");
}

function getBucket() {
  if (bucket) return bucket;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: getCredential(),
      storageBucket: getBucketName(),
    });
  }

  bucket = admin.storage().bucket(getBucketName());
  return bucket;
}

function getCategoryFolder(categoryId) {
  const folders = {
    1: "siswa",
    2: "guru",
    3: "inventaris",
    4: "surat",
  };
  return folders[Number(categoryId)] || "lainnya";
}

function ensureAllowedFile(file) {
  const originalName = file.originalname || "";
  const dotIndex = originalName.lastIndexOf(".");
  const ext = dotIndex >= 0 ? originalName.slice(dotIndex).toLowerCase() : "";

  if (!ALLOWED_MIME.has(file.mimetype) && !ALLOWED_EXT.has(ext)) {
    const err = new Error(`Tipe file tidak diizinkan: ${file.mimetype} (${ext})`);
    err.status = 415;
    throw err;
  }
}

function buildFilePath(file, categoryId) {
  const safeName = (file.originalname || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
  const folder = getCategoryFolder(categoryId);
  const year = new Date().getFullYear();
  return `sakura/documents/${folder}/${year}/${Date.now()}-${uuidv4()}-${safeName}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadFile(file, categoryId) {
  if (!file?.buffer) throw new Error("File buffer wajib diisi");
  ensureAllowedFile(file);

  const storageBucket = getBucket();
  const filePath = buildFilePath(file, categoryId);
  const storageFile = storageBucket.file(filePath);
  const downloadToken = uuidv4();

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await storageFile.save(file.buffer, {
        resumable: false,
        contentType: file.mimetype,
        metadata: {
          contentDisposition: `inline; filename="${(file.originalname || "document").replace(/"/g, "_")}"`,
          metadata: {
            firebaseStorageDownloadTokens: downloadToken,
            originalFilename: file.originalname || "document",
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      return {
        blobName: filePath,
        url: buildDownloadUrl(storageBucket.name, filePath, downloadToken),
        size: file.size,
        mimeType: file.mimetype,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[FirebaseStorage] Upload attempt ${attempt}/${MAX_RETRY} failed:`, err.message);
      if (attempt < MAX_RETRY) await sleep(500 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error(`Upload ke Firebase Storage gagal setelah ${MAX_RETRY} percobaan: ${lastError?.message}`);
}

function buildDownloadUrl(bucketName, filePath, token) {
  const encodedPath = encodeURIComponent(filePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`;
}

async function getFileUrl(filePath) {
  if (!filePath) throw new Error("filePath wajib diisi");

  const storageBucket = getBucket();
  const storageFile = storageBucket.file(filePath);
  const [metadata] = await storageFile.getMetadata();
  let token = metadata?.metadata?.firebaseStorageDownloadTokens;

  if (!token) {
    token = uuidv4();
    await storageFile.setMetadata({
      metadata: {
        ...(metadata?.metadata || {}),
        firebaseStorageDownloadTokens: token,
      },
    });
  }

  return buildDownloadUrl(storageBucket.name, filePath, token);
}

async function downloadFileBuffer(filePath) {
  if (!filePath) throw new Error("filePath wajib diisi");
  const [buffer] = await getBucket().file(filePath).download();
  return buffer;
}

async function deleteFile(filePath) {
  if (!filePath) return;
  try {
    await getBucket().file(filePath).delete({ ignoreNotFound: true });
  } catch (err) {
    if (err.code !== 404) console.warn("[FirebaseStorage] deleteFile warning:", err.message);
  }
}

async function checkFileExists(filePath) {
  if (!filePath) return false;
  try {
    const [exists] = await getBucket().file(filePath).exists();
    return exists;
  } catch (err) {
    console.warn("[FirebaseStorage] checkFileExists warning:", err.message);
    return false;
  }
}

async function checkConnection() {
  const bucketName = getBucketName();
  try {
    const [exists] = await getBucket().exists();
    return {
      ok: exists,
      bucket: bucketName,
      message: exists ? "Bucket OK" : "Bucket tidak ditemukan",
    };
  } catch (err) {
    return { ok: false, bucket: bucketName, message: err.message };
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  getFileUrl,
  downloadFileBuffer,
  checkFileExists,
  checkConnection,
};
