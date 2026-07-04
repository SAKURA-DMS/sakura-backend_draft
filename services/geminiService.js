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

module.exports = { askGemini };