// Core business logic for granting and checking plugin access, now including
// the credit/package system: every approved user belongs to a package
// (lite/core/plus/max), which determines their starting tokens, how many
// tokens they get back on each refill, how often refills happen, and the
// maximum balance they can stockpile. VIP status boosts both the refill
// amount and the cap a little further.
//
// Refills are computed LAZILY: there is no background timer running. Every
// time getLicenseStatus() is called (the plugin polls this every ~15s), we
// check whether one or more refill intervals have elapsed since the last
// one and top up the balance then — accurate even if nobody checked in for
// hours, and needs no cron job or extra infrastructure.
//
// NOTE: tokens are not yet SPENT anywhere — that wiring (deducting tokens
// per chat message, blocking sends at 0 balance, etc.) is a deliberately
// separate, later step. This step only tracks balances, refills, and grants.

const { readDb, writeDb } = require('../db');
const { resolveRobloxUsername } = require('../robloxApi');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('licenseService');

const MIN_DAYS = 1;
const MAX_DAYS = 3650; // 10 years — sanity cap against typos like "100000" days

// --- Package presets ------------------------------------------------------
// startTokens/refillAmount/maxTokens are null for "max" because that package
// is unlimited (owner + specially trusted people) — same -1 sentinel the
// rest of the codebase already uses for "unlimited".
const PACKAGES = {
  lite: { startTokens: 200, refillAmount: 200, refillHours: 8, maxTokens: 1200 },
  core: { startTokens: 500, refillAmount: 500, refillHours: 5, maxTokens: 2500 },
  plus: { startTokens: 1250, refillAmount: 1250, refillHours: 3, maxTokens: 7000 },
  max: { startTokens: null, refillAmount: null, refillHours: null, maxTokens: null },
};
const VALID_PACKAGES = Object.keys(PACKAGES);

// VIP perks — tune freely, these are just numbers, not architecture.
const VIP_REFILL_MULTIPLIER = 1.5; // "1.5x more tokens per refill"
const VIP_CAP_MULTIPLIER = 1.25; // "the max [cap] is a little bit higher"

class GrantError extends Error {
  constructor(step, message, cause) {
    super(message);
    this.name = 'GrantError';
    this.step = step;
    this.cause = cause;
  }
}

function validateDays(days) {
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new GrantError(
      'validate-input',
      `"days" must be a whole number between ${MIN_DAYS} and ${MAX_DAYS} (got: ${days}).`
    );
  }
}

function validatePackage(packageName) {
  if (!VALID_PACKAGES.includes(packageName)) {
    throw new GrantError(
      'validate-input',
      `"package" must be one of: ${VALID_PACKAGES.join(', ')} (got: ${packageName}).`
    );
  }
}

function validateStartTokens(startTokens) {
  if (startTokens === undefined || startTokens === null) return;
  if (!Number.isInteger(startTokens) || startTokens < 0) {
    throw new GrantError('validate-input', `"startTokens" must be a non-negative whole number (got: ${startTokens}).`);
  }
}

function isUnlimitedPackage(packageName) {
  return PACKAGES[packageName].maxTokens === null;
}

function computeCap(packageName, vip) {
  const preset = PACKAGES[packageName];
  if (preset.maxTokens === null) return -1; // unlimited
  return vip ? Math.round(preset.maxTokens * VIP_CAP_MULTIPLIER) : preset.maxTokens;
}

function computeRefillAmount(packageName, vip) {
  const preset = PACKAGES[packageName];
  if (preset.refillAmount === null) return null; // unlimited package never refills — it's never depleted
  return vip ? Math.round(preset.refillAmount * VIP_REFILL_MULTIPLIER) : preset.refillAmount;
}

// If one or more refill intervals have elapsed, top up the balance and push
// nextRefillAt forward by exactly that many intervals (rather than
// "now + interval"), so the schedule stays aligned even after a long gap.
function applyRefillIfDue(record) {
  if (record.tokensCap === -1 || !record.nextRefillAt) return record; // unlimited package — nothing to refill

  const now = Date.now();
  if (now < record.nextRefillAt) return record;

  const preset = PACKAGES[record.package];
  if (!preset || preset.refillHours === null) return record;

  const intervalMs = preset.refillHours * 60 * 60 * 1000;
  const elapsedIntervals = Math.floor((now - record.nextRefillAt) / intervalMs) + 1;
  const refillPerInterval = computeRefillAmount(record.package, record.vip);

  record.tokensBalance = Math.min(record.tokensCap, record.tokensBalance + refillPerInterval * elapsedIntervals);
  record.nextRefillAt = record.nextRefillAt + elapsedIntervals * intervalMs;
  return record;
}

/**
 * Grants a Roblox user access for a number of days, on a given package.
 *
 * @param {object} params
 * @param {string} params.robloxUsername
 * @param {number} params.days
 * @param {'lite'|'core'|'plus'|'max'} params.packageName
 * @param {boolean} [params.vip]
 * @param {number} [params.startTokens] - overrides the package's default starting balance
 * @param {string} [params.grantedByDiscordId]
 * @param {string} [params.grantedByDiscordTag]
 * @param {(entry: object, allSteps: object[]) => void} [params.onStep] - called after each step
 */
async function grantAccess({
  robloxUsername,
  days,
  packageName,
  vip,
  startTokens,
  grantedByDiscordId,
  grantedByDiscordTag,
  onStep,
}) {
  const steps = [];
  const reportStep = (label, status, detail) => {
    const entry = { label, status, detail };
    steps.push(entry);
    logger[status === 'error' ? 'error' : 'ok'](`${label}${detail ? ' — ' + detail : ''}`);
    if (onStep) onStep(entry, steps);
  };

  // Step 1: validate input
  try {
    validateDays(days);
    validatePackage(packageName);
    validateStartTokens(startTokens);
    reportStep(
      'Validated input',
      'ok',
      `days=${days}, package=${packageName}, vip=${Boolean(vip)}` +
        (startTokens !== undefined && startTokens !== null ? `, startTokens=${startTokens}` : '')
    );
  } catch (err) {
    reportStep('Validate input', 'error', err.message);
    throw err;
  }

  // Step 2: resolve Roblox username -> userId
  let resolved;
  try {
    resolved = await resolveRobloxUsername(robloxUsername);
  } catch (err) {
    const wrapped = new GrantError('resolve-username', err.message, err);
    reportStep('Resolve Roblox username', 'error', wrapped.message);
    throw wrapped;
  }
  if (!resolved) {
    const err = new GrantError('resolve-username', `No Roblox user found with username "${robloxUsername}".`);
    reportStep('Resolve Roblox username', 'error', err.message);
    throw err;
  }
  reportStep('Resolved Roblox username', 'ok', `${resolved.name} -> ID ${resolved.id}`);

  // Step 3: read the database
  let db;
  try {
    db = readDb();
  } catch (err) {
    const wrapped = new GrantError('read-database', err.message, err);
    reportStep('Read database', 'error', wrapped.message);
    throw wrapped;
  }
  const key = String(resolved.id);
  const existing = db.licenses[key];
  if (existing) {
    const expiryText = existing.expiresAt ? new Date(existing.expiresAt).toISOString() : 'n/a';
    reportStep('Found existing license', 'ok', `previous status "${existing.status}" (expiry: ${expiryText}) — will be overwritten`);
  } else {
    reportStep('No existing license found', 'ok', 'a new record will be created');
  }

  // Step 4: work out the token setup for the chosen package
  const now = Date.now();
  const unlimited = isUnlimitedPackage(packageName);
  const cap = computeCap(packageName, Boolean(vip));
  const initialBalance = unlimited
    ? -1
    : Math.min(typeof startTokens === 'number' ? startTokens : PACKAGES[packageName].startTokens, cap);
  const refillHours = PACKAGES[packageName].refillHours;
  const nextRefillAt = unlimited ? null : now + refillHours * 60 * 60 * 1000;
  const expiresAt = now + days * 24 * 60 * 60 * 1000;

  // Step 5: write the new record
  const record = {
    robloxUserId: resolved.id,
    robloxUsername: resolved.name,
    status: 'approved',
    package: packageName,
    vip: Boolean(vip),
    tokensBalance: initialBalance,
    tokensCap: cap,
    nextRefillAt,
    grantedAt: now,
    expiresAt,
    grantedByDiscordId: grantedByDiscordId || null,
    grantedByDiscordTag: grantedByDiscordTag || null,
  };

  try {
    db.licenses[key] = record;
    writeDb(db);
  } catch (err) {
    const wrapped = new GrantError('write-database', err.message, err);
    reportStep('Write database', 'error', wrapped.message);
    throw wrapped;
  }
  reportStep(
    'Wrote license record',
    'ok',
    `package=${packageName}${vip ? ' (VIP)' : ''}, tokens=${unlimited ? 'unlimited' : `${initialBalance}/${cap}`}, access until ${new Date(expiresAt).toISOString()}`
  );

  return { record, steps };
}

/**
 * Reads the current license status for a Roblox user, matching the shape
 * the Roblox plugin's Dashboard/App-gate code expects. Applies any refill
 * that's come due since the last check before returning.
 */
function getLicenseStatus(robloxUserId) {
  const db = readDb();
  const key = String(robloxUserId);
  let record = db.licenses[key];
  if (!record) {
    return { status: 'not_found' };
  }

  if (record.status === 'approved' && record.expiresAt && record.expiresAt <= Date.now()) {
    record.status = 'expired';
    db.licenses[key] = record;
    writeDb(db);
    logger.info(`License for robloxUserId=${robloxUserId} lazily flipped to "expired"`);
    return record;
  }

  if (record.status === 'approved') {
    const before = record.tokensBalance;
    const beforeRefillAt = record.nextRefillAt;
    record = applyRefillIfDue(record);
    if (record.tokensBalance !== before || record.nextRefillAt !== beforeRefillAt) {
      db.licenses[key] = record;
      writeDb(db);
      logger.info(`License for robloxUserId=${robloxUserId} refilled -> ${record.tokensBalance}/${record.tokensCap}`);
    }
  }

  return record;
}

/**
 * Creates a "pending" record the first time a user requests access.
 * Never overwrites an existing record (approved/denied/etc.).
 */
function requestAccess({ robloxUsername, robloxUserId }) {
  const db = readDb();
  const key = String(robloxUserId);
  const existing = db.licenses[key];
  if (existing) {
    return existing;
  }
  const record = {
    robloxUserId: Number(robloxUserId),
    robloxUsername,
    status: 'pending',
    package: null,
    vip: false,
    tokensBalance: -1,
    tokensCap: -1,
    nextRefillAt: null,
    grantedAt: null,
    expiresAt: null,
    requestedAt: Date.now(),
  };
  db.licenses[key] = record;
  writeDb(db);
  return record;
}

module.exports = {
  grantAccess,
  getLicenseStatus,
  requestAccess,
  GrantError,
  PACKAGES,
  VALID_PACKAGES,
};
