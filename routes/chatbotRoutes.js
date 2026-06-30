const express                = require("express");
const { authRequired }       = require("../middleware/auth");
const { handleChat }         = require("../controllers/chatbotController");

const router = express.Router();

// Semua route chatbot memerlukan autentikasi JWT
router.use(authRequired);

// POST /api/chatbot
// Body: { message: string }
router.post("/", handleChat);

module.exports = router;
