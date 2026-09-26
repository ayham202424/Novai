require('dotenv').config();

const { createServer } = require('./server');
const { startDiscordBot } = require('./discord/client');
const { createScopedLogger } = require('./logger');

const logger = createScopedLogger('bootstrap');

async function main() {
  logger.step('Starting Novai backend...');

  const requiredEnv = ['PLUGIN_API_KEY', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'GEMINI_API_KEY'];
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  const app = createServer();
  app.listen(port, () => {
    logger.ok(`API server listening on port ${port}`);
  });

  try {
    await startDiscordBot();
  } catch (err) {
    logger.error(`Failed to start Discord bot: ${err.message}`, err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`, reason);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err);
});

main();
