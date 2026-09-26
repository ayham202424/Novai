// Stores each Roblox user's recent chat history in the same JSON database
// used for licenses, under its own top-level key. Capped per user so the
// context fed to Gemini (and the file on disk) never grows unbounded.

const { readDb, writeDb } = require('../db');

const MAX_HISTORY_MESSAGES = 20;

function getHistory(robloxUserId) {
  const db = readDb();
  const key = String(robloxUserId);
  return (db.chatHistories && db.chatHistories[key]) || [];
}

function appendHistory(robloxUserId, role, content) {
  const db = readDb();
  if (!db.chatHistories) db.chatHistories = {};
  const key = String(robloxUserId);
  const history = db.chatHistories[key] || [];
  history.push({ role, content, timestamp: Date.now() });
  db.chatHistories[key] = history.slice(-MAX_HISTORY_MESSAGES);
  writeDb(db);
}

module.exports = { getHistory, appendHistory };
