const express = require('express');
const { answerChatJob } = require('../services/chatService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('POST /chat-answer');
const router = express.Router();

router.post('/chat-answer', (req, res) => {
  const { jobId, answer } = req.body || {};
  if (!jobId || !answer || !String(answer).trim()) {
    return res.status(400).json({ error: 'jobId and answer are both required.' });
  }

  try {
    answerChatJob({ jobId: String(jobId), answer: String(answer) });
    logger.info(`Resumed job ${jobId} with an answer.`);
    return res.json({ ok: true });
  } catch (err) {
    logger.warn(`Failed to resume job ${jobId}: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
