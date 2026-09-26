// Small structured logger used everywhere in this project.
// Every line is timestamped and tagged with a "scope" (which module logged it)
// and a "level", so when something goes wrong on Railway it's immediately
// obvious *where* it happened and *what* step failed.

const LEVELS = {
  INFO: 'INFO',
  STEP: 'STEP',
  OK: 'OK',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

function timestamp() {
  return new Date().toISOString();
}

function log(level, scope, message, extra) {
  const line = `[${timestamp()}] [${level}] [${scope}] ${message}`;
  if (level === LEVELS.ERROR) {
    console.error(line);
    if (extra && extra.stack) console.error(extra.stack);
    else if (extra) console.error(extra);
  } else if (level === LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Creates a logger pre-tagged with a scope name, e.g. createScopedLogger('licenseService').
 * Use .step() for "about to do X", .ok() for "X succeeded", .error() for failures.
 */
function createScopedLogger(scope) {
  return {
    info: (msg) => log(LEVELS.INFO, scope, msg),
    step: (msg) => log(LEVELS.STEP, scope, msg),
    ok: (msg) => log(LEVELS.OK, scope, msg),
    warn: (msg) => log(LEVELS.WARN, scope, msg),
    error: (msg, extra) => log(LEVELS.ERROR, scope, msg, extra),
  };
}

module.exports = { createScopedLogger };
