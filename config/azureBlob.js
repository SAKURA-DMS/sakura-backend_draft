const {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const connStr            = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName      = process.env.AZURE_BLOB_CONTAINER || "sakura-documents";
const SAS_EXPIRY_MINUTES = Number(process.env.AZURE_SAS_EXPIRY_MINUTES || 60);
const MAX_RETRY          = 3;

let containerClient      = null;
let sharedKeyCredential  = null;
let accountName          = null;

// ── Parse connection string untuk credential SAS ──────────────────────────────
function parseConnectionString(cs) {
  if (!cs) return {};
  const parts = {};
  cs.split(";").forEach((seg) => {
    const idx = seg.indexOf("=");
    if (idx > 0) parts[seg.slice(0, idx)] = seg.slice(idx + 1);
  });
  return parts;
}

// ── Lazy init container ───────────────────────────────────────────────────────
function getContainer() {
  if (containerClient) return containerClient;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING belum diset di .env");

  const blobSvc = BlobServiceClient.fromConnectionString(connStr);
  containerClient = blobSvc.getContainerClient(containerName);

  const parsed = parseConnectionString(connStr);
  if (parsed.AccountName && parsed.AccountKey) {
    accountName = parsed.AccountName;
    sharedKeyCredential = new StorageSharedKeyCredential(parsed.AccountName, parsed.AccountKey);
  }

  return containerClient;
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Upload dengan retry ───────────────────────────────────────────────────────
/**
 * Upload file buffer ke Azure Blob Storage.
 * Retry otomatis hingga MAX_RETRY kali dengan exponential backoff.
 *
 * @param {Express.Multer.File} file   — object dari multer
 * @param {string} folderPrefix        — prefix path di dalam container
 * @returns {Promise<{ blobName, url, size, mimeType }>}
 */
async function uploadBufferToBlob(file, folderPrefix = "documents") {
  const container = getContainer();
  await container.createIfNotExists();

  const safeName  = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobName  = `${folderPrefix}/${new Date().getFullYear()}/${Date.now()}-${uuidv4()}-${safeName}`;
  const blockBlobClient = container.getBlockBlobClient(blobName);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await blockBlobClient.uploadData(file.buffer, {
        blobHTTPHeaders: {
          blobContentType:        file.mimetype,
          blobContentDisposition: `inline; filename="${safeName}"`,
        },
        metadata: {
          originalFilename: safeName,
          uploadedAt:       new Date().toISOString(),
        },
      });
      return { blobName, url: blockBlobClient.url, size: file.size, mimeType: file.mimetype };
    } catch (err) {
      lastError = err;
      console.warn(`[AzureBlob] Upload attempt ${attempt}/${MAX_RETRY} failed:`, err.message);
      if (attempt < MAX_RETRY) await sleep(500 * Math.pow(2, attempt - 1));
    }
  }
  throw new Error(`Upload ke Azure gagal setelah ${MAX_RETRY} percobaan: ${lastError?.message}`);
}

// ── Generate SAS URL (read-only, sementara) ───────────────────────────────────
/**
 * Buat SAS URL untuk membaca file secara sementara.
 *
 * @param {string} blobName
 * @param {number} expiryMinutes
 * @returns {Promise<string>}
 */
async function generateSasUrl(blobName, expiryMinutes = SAS_EXPIRY_MINUTES) {
  if (!blobName) throw new Error("blobName wajib diisi");

  const container = getContainer();

  if (!sharedKeyCredential) {
    const blockBlobClient = container.getBlockBlobClient(blobName);
    return blockBlobClient.url;
  }

  const startsOn  = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60 * 1000);

  const sasQueryParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    },
    sharedKeyCredential
  );

  const blockBlobClient = container.getBlockBlobClient(blobName);
  return `${blockBlobClient.url}?${sasQueryParams.toString()}`;
}

// ── Download blob sebagai Buffer ──────────────────────────────────────────────
/**
 * Unduh blob dari Azure dan kembalikan sebagai Node.js Buffer.
 * Digunakan untuk watermarking server-side.
 *
 * @param {string} blobName
 * @returns {Promise<Buffer>}
 */
async function downloadBlobBuffer(blobName) {
  if (!blobName) throw new Error("blobName wajib diisi");
  const container      = getContainer();
  const blockBlobClient = container.getBlockBlobClient(blobName);
  const downloadResp   = await blockBlobClient.download(0);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = downloadResp.readableStreamBody;
    stream.on("data",  (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end",   ()      => resolve(Buffer.concat(chunks)));
    stream.on("error", (err)   => reject(err));
  });
}

// ── Hapus blob ────────────────────────────────────────────────────────────────
async function deleteBlob(blobName) {
  if (!blobName) return;
  try {
    const container = getContainer();
    await container.deleteBlob(blobName, { deleteSnapshots: "include" });
  } catch (err) {
    if (err.statusCode !== 404) console.warn("[AzureBlob] deleteBlob warning:", err.message);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
async function checkConnection() {
  try {
    const container = getContainer();
    const exists = await container.exists();
    if (!exists) await container.createIfNotExists();
    return { ok: true, container: containerName, message: exists ? "Container OK" : "Container dibuat baru" };
  } catch (err) {
    return { ok: false, container: containerName, message: err.message };
  }
}

module.exports = { uploadBufferToBlob, generateSasUrl, downloadBlobBuffer, deleteBlob, checkConnection };