const express = require('express');
const { getJobStatus } = require('../services/chatService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('GET /chat-status');
const router = express.Router();

router.get('/chat-status', (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId query parameter is required.' });
  }

  const status = getJobStatus(String(jobId));
  if (!status) {
    logger.warn(`Unknown jobId requested: ${jobId}`);
    return res.status(404).json({ error: 'No such job. It may have expired.' });
  }
  return res.json(status);
});

module.exports = router;
