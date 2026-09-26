const express = require('express');
const { getOrCreateDefaultConversation } = require('../services/conversationService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('GET /chat-history');
const router = express.Router();

// Deprecated: kept only so plugin builds from before the multi-chat system
// keep working without any regression. It now reads from the "default"
// conversation instead of the old flat per-user history file. New plugin
// code should use GET /conversation?conversationId=... instead.
router.get('/chat-history', (req, res) => {
  const robloxUserId = req.query.robloxUserId;
  if (!robloxUserId) {
    return res.status(400).json({ error: 'robloxUserId query parameter is required.' });
  }

  try {
    const conversation = getOrCreateDefaultConversation(String(robloxUserId));
    const messages = conversation.messages.map((h) => ({ role: h.role, content: h.content }));
    return res.json({ messages });
  } catch (err) {
    logger.error(`Failed to read chat history for robloxUserId=${robloxUserId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while reading chat history.' });
  }
});

module.exports = router;
