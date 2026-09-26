// A sliding-window rate limiter + FIFO queue for outgoing Gemini requests.
// Instead of firing every request immediately and getting hard 429 errors
// when too many land in the same minute (which happens fast once more than
// one or two people are chatting at once), calls are queued and released
// only as fast as the free tier's rate limit actually allows.
//
// This does NOT increase how much total capacity you have — Google's limit
// is still Google's limit — but it turns "several people burst requests and
// some of them get an ugly error" into "everyone queues for a few seconds
// and all of them succeed", using 100% of the free quota instead of wasting
// attempts on requests that get rejected outright.

const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('geminiQueue');

// Leave a small safety margin below Google's actual limit (15/min on the
// free tier at the time of writing) so clock skew and rounding never tip us
// over into a real 429. Override with GEMINI_MAX_RPM if your project's
// limit is different (check the AI Studio dashboard for the real number).
const MAX_REQUESTS_PER_WINDOW = Number(process.env.GEMINI_MAX_RPM) || 13;
const WINDOW_MS = 60 * 1000;

const requestTimestamps = []; // sliding window of when the last accepted requests fired
const queue = [];
let dispatching = false;

function msUntilNextSlot() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) return 0;
  return WINDOW_MS - (now - requestTimestamps[0]) + 50; // +50ms safety buffer
}

async function dispatchLoop() {
  if (dispatching) return;
  dispatching = true;
  while (queue.length > 0) {
    const wait = msUntilNextSlot();
    if (wait > 0) {
      if (queue.length > 1) {
        logger.info(`Rate limit window full — ${queue.length} request(s) queued, next slot in ${wait}ms`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    const job = queue.shift();

    // The job may have been cancelled (Stop button) while it was waiting in
    // line — skip it without spending a real rate-limit slot on it.
    if (job.signal && job.signal.aborted) {
      job.reject(new Error('Request was cancelled.'));
      continue;
    }

    requestTimestamps.push(Date.now());
    job.run();
  }
  dispatching = false;
}

/**
 * Runs `fn` (a zero-argument async function) once a slot in the rate-limit
 * window is free. Resolves/rejects with whatever `fn` resolves/rejects with.
 * Pass the job's AbortSignal so a cancelled job can be dropped from the
 * queue instead of wasting a slot once its turn comes up.
 */
function schedule(fn, signal) {
  return new Promise((resolve, reject) => {
    queue.push({
      signal,
      reject,
      run: () => {
        fn().then(resolve, reject);
      },
    });
    dispatchLoop();
  });
}

function queueLength() {
  return queue.length;
}

module.exports = { schedule, queueLength, MAX_REQUESTS_PER_WINDOW };
