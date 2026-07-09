const { createClient } = require("@supabase/supabase-js");
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

// Signed URL berlaku selama ini jika tidak diminta expiry custom
const DEFAULT_SIGNED_URL_EXPIRY_SEC = 60 * 60; // 1 jam

let supabaseClient = null;

function getBucketName() {
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error("SUPABASE_STORAGE_BUCKET belum diset di .env");
  return bucketName;
}

function getClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diset di .env");
  }

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return supabaseClient;
}

function getBucket() {
  const client = getClient();
  return client.storage.from(getBucketName());
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

  const bucket = getBucket();
  const filePath = buildFilePath(file, categoryId);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { error } = await bucket.upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
        cacheControl: "3600",
      });

      if (error) throw error;

      return {
        blobName: filePath,
        url: await buildSignedUrl(filePath, DEFAULT_SIGNED_URL_EXPIRY_SEC),
        size: file.size,
        mimeType: file.mimetype,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[SupabaseStorage] Upload attempt ${attempt}/${MAX_RETRY} failed:`, err.message);
      if (attempt < MAX_RETRY) await sleep(500 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error(`Upload ke Supabase Storage gagal setelah ${MAX_RETRY} percobaan: ${lastError?.message}`);
}

async function buildSignedUrl(filePath, expirySeconds) {
  const bucket = getBucket();
  const { data, error } = await bucket.createSignedUrl(filePath, expirySeconds);
  if (error) throw new Error(`Gagal membuat signed URL: ${error.message}`);
  return data.signedUrl;
}

async function getFileUrl(filePath, expirySeconds = DEFAULT_SIGNED_URL_EXPIRY_SEC) {
  if (!filePath) throw new Error("filePath wajib diisi");
  return buildSignedUrl(filePath, expirySeconds);
}

async function downloadFileBuffer(filePath) {
  if (!filePath) throw new Error("filePath wajib diisi");
  const bucket = getBucket();
  const { data, error } = await bucket.download(filePath);
  if (error) throw new Error(`Gagal mengunduh file dari Supabase Storage: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function deleteFile(filePath) {
  if (!filePath) return;
  try {
    const bucket = getBucket();
    const { error } = await bucket.remove([filePath]);
    if (error && error.statusCode !== "404") {
      console.warn("[SupabaseStorage] deleteFile warning:", error.message);
    }
  } catch (err) {
    console.warn("[SupabaseStorage] deleteFile warning:", err.message);
  }
}

async function checkFileExists(filePath) {
  if (!filePath) return false;
  try {
    const bucket = getBucket();
    const lastSlash = filePath.lastIndexOf("/");
    const folder = lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
    const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

    const { data, error } = await bucket.list(folder, {
      search: fileName,
    });

    if (error) {
      console.warn("[SupabaseStorage] checkFileExists warning:", error.message);
      return false;
    }

    return Array.isArray(data) && data.some((item) => item.name === fileName);
  } catch (err) {
    console.warn("[SupabaseStorage] checkFileExists warning:", err.message);
    return false;
  }
}

async function checkConnection() {
  const bucketName = getBucketName();
  try {
    const client = getClient();
    const { data, error } = await client.storage.getBucket(bucketName);
    const exists = !error && !!data;
    return {
      ok: exists,
      bucket: bucketName,
      message: exists ? "Bucket OK" : error?.message || "Bucket tidak ditemukan",
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