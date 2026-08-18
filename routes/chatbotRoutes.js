const express                = require("express");
const { authRequired }       = require("../middleware/auth");
const { handleChat }         = require("../controllers/chatbotController");

const router = express.Router();

// All chatbot routes require JWT authentication 
router.use(authRequired);

// POST /api/chatbot
// Body: { message: string }
router.post("/", handleChat);

module.exports = router;
