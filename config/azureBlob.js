const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_BLOB_CONTAINER || "sakura-documents";

let containerClient = null;

function getContainer() {
  if (containerClient) return containerClient;
  if (!connStr) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING belum diset di .env");
  }
  const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  containerClient = blobServiceClient.getContainerClient(containerName);
  return containerClient;
}

/**
 * Upload buffer ke Azure Blob Storage.
 * @returns {Promise<{blobName:string,url:string,size:number,mimeType:string}>}
 */
async function uploadBufferToBlob(file, folderPrefix = "documents") {
  const container = getContainer();
  await container.createIfNotExists();

  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobName = `${folderPrefix}/${Date.now()}-${uuidv4()}-${safeName}`;
  const blockBlobClient = container.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(file.buffer, {
    blobHTTPHeaders: { blobContentType: file.mimetype },
  });

  return {
    blobName,
    url: blockBlobClient.url,
    size: file.size,
    mimeType: file.mimetype,
  };
}

async function deleteBlob(blobName) {
  if (!blobName) return;
  const container = getContainer();
  await container.deleteBlob(blobName, { deleteSnapshots: "include" }).catch(() => {});
}

module.exports = { uploadBufferToBlob, deleteBlob };
