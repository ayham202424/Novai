// Talks to Roblox's public API to turn a username into a userId, and to
// confirm the username actually exists (catches typos immediately instead
// of silently granting access to a non-existent account).

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {string} username
 * @returns {Promise<{ id: number, name: string } | null>} null if no such user exists
 */
async function resolveRobloxUsername(username) {
  const trimmed = (username || '').trim();
  if (!trimmed) {
    throw new Error('Username is empty.');
  }

  let response;
  try {
    response = await fetchWithTimeout('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [trimmed], excludeBannedUsers: false }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Roblox API did not respond in time (timeout).');
    }
    throw new Error(`Could not reach the Roblox API: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`Roblox API responded with HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`Roblox API returned an unreadable response: ${err.message}`);
  }

  const match = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!match) {
    return null;
  }
  return { id: match.id, name: match.name };
}

module.exports = { resolveRobloxUsername };
