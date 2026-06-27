const https = require("https");

function getApiKey() {
  return process.env.GEMINI_API_KEY;
}

/**
 * Model tersedia di API key ini (hasil checkGeminiModels.js).
 * Urutan: terbaik → fallback ringan.
 */
const GEMINI_MODELS = [
  "gemini-2.5-flash",      // prioritas utama: cepat, kapabel, tersedia
  "gemini-2.0-flash",      // fallback 1
  "gemini-2.0-flash-lite", // fallback 2: paling ringan
];

function buildUrl(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Request Queue: max 1 request aktif, jeda 2 detik antar call ──────────────
let _queueRunning = false;
const _queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (_queueRunning || _queue.length === 0) return;
  _queueRunning = true;
  const { fn, resolve, reject } = _queue.shift();
  try {
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    await sleep(2000); // jeda 2 detik antar request
    _queueRunning = false;
    processQueue();
  }
}

/**
 * Kirim prompt ke Gemini.
 * - Request queue (1 request aktif, jeda 2s)
 * - Retry 2x saat 429 (jeda 5s, 10s)
 * - Fallback ke model berikutnya saat 403/404/5xx
 */
async function askGemini(systemPrompt, userMessage) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your-gemini-api-key-here" || !apiKey.trim()) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env backend.");
  }

  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
  });

  return enqueue(() => _askWithFallback(payload, apiKey));
}

async function _askWithFallback(payload, apiKey) {
  const MAX_RETRIES = 2;
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callGemini(buildUrl(model, apiKey), payload, model);
      } catch (err) {
        lastError = err;
        const code = extractStatusCode(err.message);

        if (code === 429) {
          if (attempt < MAX_RETRIES) {
            const wait = 5000 * attempt;
            console.warn(`[GeminiService] 429 model="${model}" attempt=${attempt}, retry in ${wait}ms...`);
            await sleep(wait);
            continue;
          }
          console.warn(`[GeminiService] Model "${model}" tetap 429, ganti model.`);
          break;
        }

        if (code === 403 || code === 404 || code >= 500) {
          console.warn(`[GeminiService] Model "${model}" [${code}], ganti model.`);
          break;
        }

        throw err;
      }
    }
  }

  const code = extractStatusCode(lastError?.message || "");
  if (code === 429) throw new Error("GEMINI_429");
  if (code === 403) throw new Error("GEMINI_403");
  throw lastError || new Error("Semua model Gemini gagal.");
}

function extractStatusCode(msg) {
  const m = msg.match(/\[(\d{3})\]/);
  return m ? parseInt(m[1]) : 0;
}

function callGemini(url, payload, model) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const msg = data?.error?.message || `HTTP ${res.statusCode}`;
              return reject(new Error(`[${res.statusCode}] model=${model}: ${msg}`));
            }
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (!text) {
              const reason = data?.candidates?.[0]?.finishReason;
              return reject(new Error(
                reason && reason !== "STOP"
                  ? `[400] finishReason: ${reason}`
                  : `[503] Respons kosong model=${model}`
              ));
            }
            resolve(text.trim());
          } catch (e) {
            reject(new Error(`[500] Parse error: ${e.message}`));
          }
        });
      }
    );
    req.setTimeout(25000, () => { req.destroy(); reject(new Error(`[503] Timeout model=${model}`)); });
    req.on("error", (e) => reject(new Error(`[503] Network: ${e.message}`)));
    req.write(payload);
    req.end();
  });
}

module.exports = { askGemini };