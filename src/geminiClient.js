// Thin wrapper around Google's Gemini REST API (the stable `generateContent`
// endpoint — not the newer beta "Interactions" API — chosen deliberately for
// production reliability).
//
// IMPORTANT — READ BEFORE 16 OCTOBER 2026:
// Google is retiring the entire Gemini 2.5 model family (including
// gemini-2.5-flash-lite, this file's default model) on 16 October 2026.
// It is the best free-tier model available today, but after that date it
// will stop responding entirely. When that happens, set the GEMINI_MODEL
// environment variable (in Railway) to whatever free-tier model Google
// offers at that time — no code change needed here.
//
// Every request goes through rateLimiter.schedule(), which queues calls so
// they never exceed the free tier's requests-per-minute limit in the first
// place (see services/rateLimiter.js for why). If a 429 slips through
// anyway, this file retries automatically using the wait time Google itself
// reports, up to a few attempts, before giving up.

const { createScopedLogger } = require('./logger');
const { schedule } = require('./services/rateLimiter');

const logger = createScopedLogger('geminiClient');

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MAX_ATTEMPTS = 3;

class RetryableGeminiError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RetryableGeminiError';
    this.retryAfterMs = retryAfterMs;
  }
}

// externalSignal lets a caller (chatService, for its Stop button) cancel a
// request that's already in flight, in addition to the built-in timeout.
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, externalSignal = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// One actual HTTP attempt. Throws RetryableGeminiError for a 429 (caller
// decides whether/how long to wait and retry), or a plain Error for
// anything else (cancellation, timeout, bad response, empty output).
async function performRequest(url, body, signal) {
  let response;
  try {
    response = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      30000,
      signal
    );
  } catch (err) {
    if (signal && signal.aborted) {
      throw new Error('Request was cancelled.');
    }
    if (err.name === 'AbortError') {
      throw new Error('Gemini API did not respond in time (timeout).');
    }
    throw new Error(`Could not reach the Gemini API: ${err.message}`);
  }

  if (!response.ok) {
    let details = '';
    try {
      const errBody = await response.json();
      if (errBody && errBody.error && errBody.error.message) {
        details = ` — ${errBody.error.message}`;
      }
    } catch (_parseErr) {
      // Response body wasn't JSON — ignore, details stays empty.
    }

    if (response.status === 429) {
      // Prefer the standard header; fall back to parsing Google's own
      // "Please retry in 15.9s" text out of the error message.
      const headerValue = response.headers && response.headers.get ? response.headers.get('retry-after') : null;
      let retryAfterMs = headerValue ? Number(headerValue) * 1000 : NaN;
      if (Number.isNaN(retryAfterMs)) {
        const match = details.match(/retry in ([\d.]+)\s*s/i);
        retryAfterMs = match ? Math.ceil(parseFloat(match[1]) * 1000) : NaN;
      }
      if (Number.isNaN(retryAfterMs)) retryAfterMs = 8000;
      throw new RetryableGeminiError(`Gemini API rate limit reached${details}`, retryAfterMs + 500);
    }

    throw new Error(`Gemini API responded with HTTP ${response.status}${details}`);
  }

  const data = await response.json();
  const candidate = data && data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';

  if (!text) {
    const finishReason = (candidate && candidate.finishReason) || 'unknown';
    logger.warn(`Gemini returned no text (finishReason: ${finishReason})`);
    throw new Error(`Gemini returned an empty response (finishReason: ${finishReason}).`);
  }

  return text;
}

/**
 * Calls Gemini's generateContent endpoint with a system instruction and a
 * flat list of conversation turns.
 *
 * @param {object} params
 * @param {string} params.systemInstruction
 * @param {{role: 'user'|'model', text: string}[]} params.turns
 * @param {AbortSignal} [params.signal] - lets the caller cancel this request early
 * @returns {Promise<string>} the model's text response
 */
async function generate({ systemInstruction, turns, signal }) {
  if (signal && signal.aborted) {
    throw new Error('Request was cancelled.');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 4096,
    },
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await schedule(() => performRequest(url, body, signal), signal);
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (err instanceof RetryableGeminiError && !isLastAttempt) {
        logger.warn(`Gemini rate-limited; retrying in ${err.retryAfterMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs));
        continue;
      }
      if (err instanceof RetryableGeminiError) {
        throw new Error(err.message); // retries exhausted — surface a normal error
      }
      throw err;
    }
  }

  // Unreachable, but keeps the function's return type honest for linters.
  throw new Error('Gemini request failed after all retries.');
}

module.exports = { generate };
