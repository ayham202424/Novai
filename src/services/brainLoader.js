// Loads all of Novai's "brain" files once and concatenates them into a
// single system instruction, in a fixed, deliberate order. Cached in memory
// after the first read since these files never change at runtime.

const fs = require('fs');
const path = require('path');

const BRAIN_DIR = path.join(__dirname, '..', 'brain');
const FILES_IN_ORDER = [
  'identity.md',
  'methodology.md',
  'formatting.md',
  'roblox_knowledge.md',
  'question_protocol.md',
];

let cached = null;

function loadBrain() {
  if (cached) return cached;
  const sections = FILES_IN_ORDER.map((name) => {
    const filePath = path.join(BRAIN_DIR, name);
    return fs.readFileSync(filePath, 'utf-8').trim();
  });
  cached = sections.join('\n\n---\n\n');
  return cached;
}

module.exports = { loadBrain };
