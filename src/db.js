// Minimal JSON-file "database". No native modules, nothing to compile —
// deploys reliably everywhere, including Railway's build environment.
//
// IMPORTANT: on Railway, container filesystems are wiped on every redeploy
// unless you attach a Volume. Mount a Volume and point DB_PATH at a file
// inside it (see .env.example / README.md), or every deploy will erase
// all granted licenses.

const fs = require('fs');
const path = require('path');
const { createScopedLogger } = require('./logger');

const logger = createScopedLogger('db');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'db.json');

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created database directory at ${dir}`);
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ licenses: {} }, null, 2));
    logger.info(`Created new database file at ${DB_PATH}`);
  }
}

function readDb() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.licenses) parsed.licenses = {};
    return parsed;
  } catch (err) {
    throw new Error(`Database file at ${DB_PATH} is corrupted: ${err.message}`);
  }
}

function writeDb(data) {
  ensureDbFile();
  // Write to a temp file first, then rename — avoids a half-written/corrupt
  // db.json if the process crashes mid-write.
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

module.exports = { readDb, writeDb, DB_PATH };
