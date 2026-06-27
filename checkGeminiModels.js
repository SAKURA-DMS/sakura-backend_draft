/**
 * Jalankan script ini SEKALI untuk tahu model apa yang tersedia di API key Anda:
 * 
 *   node checkGeminiModels.js YOUR_API_KEY_HERE
 * 
 * atau jika GEMINI_API_KEY sudah ada di .env:
 * 
 *   node -e "require('dotenv').config(); require('./checkGeminiModels')"
 */

const https = require("https");

const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Usage: node checkGeminiModels.js YOUR_API_KEY");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

https.get(url, (res) => {
  let raw = "";
  res.on("data", (c) => (raw += c));
  res.on("end", () => {
    const data = JSON.parse(raw);
    if (data.error) {
      console.error("Error:", data.error.message);
      return;
    }
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));

    console.log("\n✅ Model yang tersedia untuk generateContent:\n");
    models.forEach((m) => console.log(" -", m));
    console.log("\nSalin model-model di atas ke GEMINI_MODELS di geminiService.js\n");
  });
});