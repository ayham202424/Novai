const express = require('express');
const { getLicenseStatus } = require('../services/licenseService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('GET /license-status');
const router = express.Router();

router.get('/license-status', (req, res) => {
  const robloxUserId = req.query.robloxUserId;
  if (!robloxUserId) {
    logger.warn('Missing robloxUserId query parameter.');
    return res.status(400).json({ error: 'robloxUserId query parameter is required.' });
  }

  try {
    const status = getLicenseStatus(robloxUserId);
    logger.info(`robloxUserId=${robloxUserId} -> status=${status.status}`);
    return res.json(status);
  } catch (err) {
    logger.error(`Failed to read license status for robloxUserId=${robloxUserId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while reading license status.' });
  }
});

module.exports = router;
