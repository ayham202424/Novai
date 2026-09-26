const express = require('express');
const { requireApiKey } = require('./middleware/auth');
const licenseStatusRoute = require('./routes/licenseStatus');
const requestAccessRoute = require('./routes/requestAccess');
const chatRoute = require('./routes/chat');
const chatStatusRoute = require('./routes/chatStatus');
const chatAnswerRoute = require('./routes/chatAnswer');
const chatStopRoute = require('./routes/chatStop');
const chatHistoryRoute = require('./routes/chatHistory');
const conversationsRoute = require('./routes/conversations');
const { createScopedLogger } = require('./logger');

const logger = createScopedLogger('server');

function createServer() {
  const app = express();
  app.use(express.json());

  // Health check — no API key required. Useful for Railway/uptime monitors.
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'novai-backend' });
  });

  // Everything the Roblox plugin calls requires the shared API key.
  app.use(requireApiKey);
  app.use(licenseStatusRoute);
  app.use(requestAccessRoute);
  app.use(chatRoute);
  app.use(chatStatusRoute);
  app.use(chatAnswerRoute);
  app.use(chatStopRoute);
  app.use(chatHistoryRoute);
  app.use(conversationsRoute);

  // 404 fallback — always returns JSON, never an HTML error page.
  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // Central error handler — guarantees a JSON error body instead of a crash.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`, err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

module.exports = { createServer };
