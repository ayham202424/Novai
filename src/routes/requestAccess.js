const express = require('express');
const { requestAccess } = require('../services/licenseService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('POST /request-access');
const router = express.Router();

router.post('/request-access', (req, res) => {
  const { robloxUsername, robloxUserId } = req.body || {};
  if (!robloxUsername || !robloxUserId) {
    logger.warn('Missing robloxUsername or robloxUserId in request body.');
    return res.status(400).json({ error: 'robloxUsername and robloxUserId are both required.' });
  }

  try {
    const record = requestAccess({ robloxUsername, robloxUserId });
    logger.info(`robloxUsername=${robloxUsername} (ID ${robloxUserId}) -> status=${record.status}`);
    return res.json(record);
  } catch (err) {
    logger.error(`Failed to create access request for ${robloxUsername}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while creating the access request.' });
  }
});

module.exports = router;
