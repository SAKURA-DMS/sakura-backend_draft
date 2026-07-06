const { GoogleGenAI } = require("@google/genai");

const DEFAULT_MODEL      = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 25000;
// FIX: kurangi retry — 1 retry saja (bukan 2).
// Dengan MAX_RETRIES=2 sebelumnya, 1 request user = 3 panggilan Gemini → cepat kena rate limit.
const MAX_RETRIES = 1;

let client       = null;
let clientApiKey = null;

function getApiKey()    { return process.env.GEMINI_API_KEY; }
function getModel()     { return process.env.GEMINI_MODEL || DEFAULT_MODEL; }
function getTimeoutMs() {
  const v = Number(process.env.GEMINI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}
function getClient(apiKey) {
  if (!client || clientApiKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    clientApiKey = apiKey;
  }
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeGeminiError(err, model, attempt) {
  const status  = err?.status || err?.code || err?.response?.status || 0;
  const message = err?.message || "Unknown Gemini error";
  const e       = new Error(`[${status || "ERR"}] model=${model} attempt=${attempt}: ${message}`);
  e.status = Number(status) || 0;
  e.cause  = err;
  return e;
}

// FIX: hapus 429 dari daftar retryable!
// Sebelumnya isRetryable(429)=true → saat kena rate limit malah terus retry → makin kena limit.
function isRetryable(status) {
  return status === 0 || status === 408 || status >= 500;
  // 429 TIDAK di-retry — langsung lempar error agar frontend dapat respons cepat
}

function extractText(response) {
  if (typeof response?.text === "string") return response.text.trim();
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text).filter(Boolean).join("\n").trim();
}

async function callGemini({ systemPrompt, userMessage, apiKey, model, timeoutMs, attempt }) {
  const ai         = getClient(apiKey);
  const controller = new AbortController();
  let timeout      = null;

  try {
    const request = ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.3,
        // FIX: naikkan dari 512 → 1024.
        // 512 terlalu kecil untuk respons JSON lengkap → JSON terpotong di tengah →
        // parse gagal → raw JSON tampil di chat user.
        maxOutputTokens: 1024,
      },
      signal: controller.signal,
    });

    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const e = new Error(`Timeout setelah ${timeoutMs}ms`);
        e.status = 408;
        reject(e);
      }, timeoutMs).unref?.();
    });

    const response = await Promise.race([request, timeoutPromise]);
    const text = extractText(response);

    if (!text) {
      const reason = response?.candidates?.[0]?.finishReason || "EMPTY_RESPONSE";
      const e = new Error(`Respons kosong dari Gemini: ${reason}`);
      e.status = 503;
      throw e;
    }

    return text;
  } catch (err) {
    if (err?.name === "AbortError" || err?.status === 408) {
      const e = new Error(`Timeout setelah ${timeoutMs}ms`);
      e.status = 408;
      throw normalizeGeminiError(e, model, attempt);
    }
    throw normalizeGeminiError(err, model, attempt);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR (Gemini Vision) — dipakai oleh routes/ocr.js untuk membaca dokumen hasil
// scan (Ijazah SMP, SKL, Sertifikat, Transkrip/Rekap Nilai).
// ─────────────────────────────────────────────────────────────────────────────

const OCR_SYSTEM_PROMPT = `Kamu adalah OCR engine untuk sistem Document Management sekolah.

Analisis gambar dokumen yang diberikan.

Pertama tentukan jenis dokumen:
- ijazah
- skl
- sertifikat
- transkrip
- unsupported

Jika termasuk dokumen yang didukung, ekstrak metadata sesuai template.

Template field per jenis dokumen:
- ijazah: nama, tempat_tanggal_lahir, nama_orangtua_wali, nis, nisn, nomor_peserta, tahun_pelajaran, nama_sekolah, tanggal_kelulusan
- skl: nama, nisn, tahun_pelajaran, status_kelulusan
- sertifikat: nama_peserta, nomor_sertifikat, nama_kegiatan, tanggal_terbit
- transkrip: nama, nisn, kelas, tahun_pelajaran

Jika dokumen tidak termasuk salah satu di atas, kembalikan:
{
  "document_type":"unsupported",
  "message":"Dokumen tidak didukung OCR"
}

Kembalikan HANYA JSON valid.

Contoh:

{
  "document_type":"ijazah",
  "confidence":95,
  "fields":{
    "nama":"...",
    "tempat_tanggal_lahir":"...",
    "nama_orangtua_wali":"...",
    "nis":"...",
    "nisn":"...",
    "nomor_peserta":"...",
    "tahun_pelajaran":"...",
    "nama_sekolah":"...",
    "tanggal_kelulusan":"..."
  }
}

Jangan menambahkan markdown.
Jangan menambahkan penjelasan.
Hanya JSON.`;

function stripJsonFences(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function callGeminiVision({ imagePart, apiKey, model, timeoutMs, attempt }) {
  const ai         = getClient(apiKey);
  const controller = new AbortController();
  let timeout      = null;

  try {
    const request = ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            imagePart,
            { text: "Analisis gambar dokumen ini dan kembalikan HANYA JSON sesuai instruksi sistem." },
          ],
        },
      ],
      config: {
        systemInstruction: OCR_SYSTEM_PROMPT,
        temperature: 0.2,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
      signal: controller.signal,
    });

    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const e = new Error(`Timeout setelah ${timeoutMs}ms`);
        e.status = 408;
        reject(e);
      }, timeoutMs).unref?.();
    });

    const response = await Promise.race([request, timeoutPromise]);
    const text = extractText(response);

    if (!text) {
      const reason = response?.candidates?.[0]?.finishReason || "EMPTY_RESPONSE";
      const e = new Error(`Respons kosong dari Gemini: ${reason}`);
      e.status = 503;
      throw e;
    }

    return text;
  } catch (err) {
    if (err?.name === "AbortError" || err?.status === 408) {
      const e = new Error(`Timeout setelah ${timeoutMs}ms`);
      e.status = 408;
      throw normalizeGeminiError(e, model, attempt);
    }
    throw normalizeGeminiError(err, model, attempt);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Kirim gambar dokumen ke Gemini Vision dan kembalikan objek hasil OCR
 * ({ document_type, confidence, fields } atau { document_type: "unsupported", message }).
 *
 * @param {string} base64Image - data gambar dalam base64 (tanpa prefix data:...)
 * @param {string} mimeType - contoh: "image/jpeg", "image/png"
 */
async function analyzeDocumentImage(base64Image, mimeType) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your-gemini-api-key-here" || !apiKey.trim()) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env backend.");
  }
  if (!base64Image) {
    throw new Error("Data gambar OCR kosong.");
  }

  const model      = getModel();
  const timeoutMs  = getTimeoutMs();
  const imagePart  = { inlineData: { data: base64Image, mimeType: mimeType || "image/jpeg" } };
  let lastError    = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const text = await callGeminiVision({ imagePart, apiKey, model, timeoutMs, attempt });
      const cleaned = stripJsonFences(text);
      try {
        return JSON.parse(cleaned);
      } catch (parseErr) {
        console.error("[GeminiService] OCR JSON parse failed:", parseErr.message, "raw:", cleaned.slice(0, 300));
        const e = new Error("Respons OCR bukan JSON valid.");
        e.status = 502;
        throw e;
      }
    } catch (err) {
      lastError    = err;
      const status = err.status || 0;
      console.error("[GeminiService] OCR request failed", { model, attempt, status, message: err.message });

      if (attempt > MAX_RETRIES || !isRetryable(status)) break;
      await sleep(1500 * attempt);
    }
  }

  if (lastError?.status === 429) throw new Error("GEMINI_429");
  if (lastError?.status === 403) throw new Error("GEMINI_403");
  if (lastError?.status === 408) throw new Error("GEMINI_TIMEOUT");
  throw lastError || new Error("Gemini gagal memproses OCR.");
}

async function askGemini(systemPrompt, userMessage) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your-gemini-api-key-here" || !apiKey.trim()) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env backend.");
  }

  const model     = getModel();
  const timeoutMs = getTimeoutMs();
  let lastError   = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await callGemini({ systemPrompt, userMessage, apiKey, model, timeoutMs, attempt });
    } catch (err) {
      lastError     = err;
      const status  = err.status || 0;
      console.error("[GeminiService] request failed", { model, attempt, status, message: err.message });

      if (attempt > MAX_RETRIES || !isRetryable(status)) break;
      // Exponential backoff: tunggu lebih lama di attempt berikutnya
      await sleep(1500 * attempt);
    }
  }

  if (lastError?.status === 429) throw new Error("GEMINI_429");
  if (lastError?.status === 403) throw new Error("GEMINI_403");
  if (lastError?.status === 408) throw new Error("GEMINI_TIMEOUT");
  throw lastError || new Error("Gemini gagal memproses permintaan.");
}

module.exports = { askGemini, analyzeDocumentImage };