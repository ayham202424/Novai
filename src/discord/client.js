const { Client, GatewayIntentBits, Events } = require('discord.js');
const { createScopedLogger } = require('../logger');
const { deployCommands } = require('./deployCommands');
const grantAccessCommand = require('./commands/grantAccess');

const logger = createScopedLogger('discordClient');

// Add future commands to this array — the rest of the wiring below is generic.
const commands = [grantAccessCommand];
const commandMap = new Map(commands.map((c) => [c.data.name, c]));

function createDiscordClient() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.ok(`Logged in as ${readyClient.user.tag}`);
    try {
      await deployCommands(commands);
    } catch (err) {
      logger.error(`Failed to register slash commands: ${err.message}`, err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandMap.get(interaction.commandName);
    if (!command) {
      logger.warn(`Received unknown command: /${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(`Unhandled error while executing /${interaction.commandName}: ${err.message}`, err);
      const payload = { content: '\u26a0\ufe0f Something went wrong while running this command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  client.on(Events.Error, (err) => logger.error(`Discord client error: ${err.message}`, err));
  client.on(Events.Warn, (msg) => logger.warn(`Discord client warning: ${msg}`));

  return client;
}

async function startDiscordBot() {
  const { DISCORD_TOKEN } = process.env;
  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is not set.');
  }
  const client = createDiscordClient();
  await client.login(DISCORD_TOKEN);
  return client;
}

module.exports = { startDiscordBot };
