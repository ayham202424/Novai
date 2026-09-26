const { REST, Routes } = require('discord.js');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('deployCommands');

/**
 * Registers commands as GUILD commands (instant availability), as opposed to
 * global commands (which can take up to an hour to propagate). This runs
 * every time the bot starts — it's idempotent, so that's safe.
 */
async function deployCommands(commands) {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    throw new Error('DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID must all be set.');
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  logger.step(`Registering ${body.length} command(s) to guild ${DISCORD_GUILD_ID}...`);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
  logger.ok(`Registered: ${body.map((c) => '/' + c.name).join(', ')}`);
}

module.exports = { deployCommands };
