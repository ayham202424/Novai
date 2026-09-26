const express = require('express');
const { startChatJob } = require('../services/chatService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('POST /chat');
const router = express.Router();

router.post('/chat', (req, res) => {
  const { robloxUserId, message, conversationId } = req.body || {};
  if (!robloxUserId || !message || !String(message).trim()) {
    logger.warn('Missing robloxUserId or message in request body.');
    return res.status(400).json({ error: 'robloxUserId and message are both required.' });
  }

  try {
    const jobId = startChatJob({
      robloxUserId: String(robloxUserId),
      message: String(message),
      // Omitted by older plugin builds — falls back to a per-user "default"
      // conversation so nothing breaks during the multi-chat rollout.
      conversationId: conversationId ? String(conversationId) : null,
    });
    logger.info(
      `Started job ${jobId} for robloxUserId=${robloxUserId}` +
        (conversationId ? ` (conversation ${conversationId})` : ' (default conversation)')
    );
    return res.json({ jobId });
  } catch (err) {
    if (/No such conversation/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`Failed to start chat job for robloxUserId=${robloxUserId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while starting the chat job.' });
  }
});

module.exports = router;
