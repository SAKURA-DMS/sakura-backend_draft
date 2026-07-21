/**
 * Legacy compatibility route.
 *
 * Canonical chatbot route sekarang berada di ./chatbotRoutes.js.
 * File ini sengaja hanya menjadi alias agar tidak ada dua implementasi
 * /api/chatbot yang berbeda atau pemanggilan Gemini langsung yang menyebabkan 429.
 */
module.exports = require("./chatbotRoutes");
