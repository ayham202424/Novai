const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { grantAccess } = require('../../services/licenseService');
const { createScopedLogger } = require('../../logger');

const logger = createScopedLogger('/grant-access');

const data = new SlashCommandBuilder()
  .setName('grant-access')
  .setDescription('Grant a Roblox user access to the Novai plugin for a number of days.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt.setName('username').setDescription('The exact Roblox username').setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('days')
      .setDescription('How many days the access should last')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(3650)
  )
  .addStringOption((opt) =>
    opt
      .setName('package')
      .setDescription('Which package to grant')
      .setRequired(true)
      .addChoices(
        { name: 'Lite', value: 'lite' },
        { name: 'Core', value: 'core' },
        { name: 'Plus', value: 'plus' },
        { name: 'Max (unlimited — owner / specially trusted)', value: 'max' }
      )
  )
  .addBooleanOption((opt) =>
    opt
      .setName('vip')
      .setDescription('Grant VIP status (1.5x tokens per refill, slightly higher cap)')
      .setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('start-tokens')
      .setDescription("Custom starting token balance (defaults to the package's normal starting amount)")
      .setRequired(false)
      .setMinValue(0)
  );

function isAuthorized(interaction) {
  const allowList = (process.env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowList.length === 0) {
    // No explicit allow-list configured — rely on Discord's own permission
    // check instead (setDefaultMemberPermissions above restricts this
    // command to server Administrators).
    return true;
  }
  return allowList.includes(interaction.user.id);
}

function buildStepsEmbed({ title, color, steps, footer, extraFields }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date());
  if (steps.length > 0) {
    embed.addFields(
      steps.map((s, i) => ({
        name: `${s.status === 'error' ? '\u274c' : '\u2705'} Step ${i + 1}: ${s.label}`,
        value: s.detail || '\u2014',
      }))
    );
  }
  if (extraFields) embed.addFields(extraFields);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

async function execute(interaction) {
  if (!isAuthorized(interaction)) {
    logger.warn(`Unauthorized attempt by ${interaction.user.tag} (${interaction.user.id})`);
    await interaction.reply({ content: '\ud83d\udeab You are not allowed to use this command.', ephemeral: true });
    return;
  }

  const username = interaction.options.getString('username', true);
  const days = interaction.options.getInteger('days', true);
  const packageName = interaction.options.getString('package', true);
  const vip = interaction.options.getBoolean('vip') || false;
  const startTokens = interaction.options.getInteger('start-tokens');

  await interaction.deferReply();
  logger.step(
    `${interaction.user.tag} requested: grant "${username}" ${days} day(s), package=${packageName}, vip=${vip}` +
      (startTokens !== null ? `, startTokens=${startTokens}` : '')
  );

  const liveSteps = [];
  const refreshEmbed = async () => {
    await interaction
      .editReply({
        embeds: [buildStepsEmbed({ title: `Granting access to "${username}"...`, color: 0x6e8ed4, steps: liveSteps })],
      })
      .catch((err) => logger.warn(`Could not update progress embed: ${err.message}`));
  };

  try {
    const { record, steps } = await grantAccess({
      robloxUsername: username,
      days,
      packageName,
      vip,
      startTokens: startTokens === null ? undefined : startTokens,
      grantedByDiscordId: interaction.user.id,
      grantedByDiscordTag: interaction.user.tag,
      onStep: async (_entry, allSteps) => {
        liveSteps.length = 0;
        liveSteps.push(...allSteps);
        await refreshEmbed();
      },
    });

    const expiresUnix = Math.floor(record.expiresAt / 1000);
    const tokensText = record.tokensBalance === -1 ? 'Unlimited' : `${record.tokensBalance} / ${record.tokensCap}`;
    const finalEmbed = buildStepsEmbed({
      title: `\u2705 Access granted to ${record.robloxUsername}`,
      color: 0x4eb698,
      steps,
      footer: `Requested by ${interaction.user.tag}`,
      extraFields: [
        {
          name: 'Summary',
          value:
            `**Roblox ID:** ${record.robloxUserId}\n` +
            `**Package:** ${record.package.toUpperCase()}${record.vip ? ' \u2b50 VIP' : ''}\n` +
            `**Tokens:** ${tokensText}\n` +
            `**Duration:** ${days} day(s)\n` +
            `**Expires:** <t:${expiresUnix}:F> (<t:${expiresUnix}:R>)`,
        },
      ],
    });
    await interaction.editReply({ embeds: [finalEmbed] });
    logger.ok(`Granted "${record.robloxUsername}" (${record.robloxUserId}) access for ${days} day(s), package=${record.package}`);
  } catch (err) {
    const finalEmbed = buildStepsEmbed({
      title: `\u274c Failed to grant access to "${username}"`,
      color: 0xe08282,
      steps: liveSteps,
      footer: `Requested by ${interaction.user.tag}`,
      extraFields: [{ name: 'Error', value: err.message || 'Unknown error' }],
    });
    await interaction.editReply({ embeds: [finalEmbed] }).catch((editErr) => {
      logger.error(`Could not deliver failure embed: ${editErr.message}`, editErr);
    });
    logger.error(`Failed to grant "${username}" ${days} day(s): ${err.message}`, err);
  }
}

module.exports = { data, execute };
