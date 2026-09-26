const express = require('express');
const { cancelJob } = require('../services/chatService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('POST /chat-stop');
const router = express.Router();

// POST /chat-stop — immediately aborts the Gemini request in flight for this
// job (if any) and permanently marks the job as stopped.
router.post('/chat-stop', (req, res) => {
  const { jobId } = req.body || {};
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required.' });
  }

  try {
    cancelJob(String(jobId));
    logger.info(`Stopped job ${jobId} by user request.`);
    return res.json({ ok: true });
  } catch (err) {
    logger.warn(`Failed to stop job ${jobId}: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
