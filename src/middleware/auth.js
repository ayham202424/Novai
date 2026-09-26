const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('auth');

function requireApiKey(req, res, next) {
  const provided = req.header('x-api-key');
  const expected = process.env.PLUGIN_API_KEY;

  if (!expected) {
    logger.error('PLUGIN_API_KEY is not set on the server — refusing all requests.');
    return res.status(500).json({ error: 'Server misconfiguration: no API key configured.' });
  }
  if (!provided || provided !== expected) {
    logger.warn(`Rejected request to ${req.method} ${req.path} — invalid or missing API key.`);
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

module.exports = { requireApiKey };
