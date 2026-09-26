// The "Novai Brain" pipeline: turns one user message into a thoroughly
// planned, self-reviewed, polished answer, using Gemini as the underlying
// model. Jobs are tracked in memory and polled by the Roblox plugin via
// GET /chat-status, since Roblox's HTTP client can't hold a long-lived
// streaming connection open.
//
// Pipeline for one user message:
//   1. THINKING     — decide: ask a clarifying question, or produce a plan?
//                      (also classifies the message as SMALL_TALK or TASK)
//   2. REVIEWING xN — critique and improve the plan N times in a row, where
//                      N depends on the conversation's model tier (low/mid/
//                      high) and whether the message was small talk or a
//                      real task — see MODEL_TIERS below.
//   3. FINALIZING   — turn the fully refined plan into the polished reply
//
// If the model asks a clarifying question, the job pauses (stage
// "waiting_for_answer") until POST /chat-answer resumes it with the user's
// reply, then the pipeline continues from step 2 with that extra context.
//
// Every job carries its own AbortController. POST /chat-stop calls
// job.abortController.abort(), which immediately kills whatever Gemini
// request is currently in flight for that job — and because the SAME
// controller is reused for the rest of that job's life, any generate() call
// attempted afterwards rejects instantly too (an already-aborted signal
// makes fetch() reject right away). That's what makes Stop actually stop,
// instead of just abandoning the job client-side while it keeps burning API
// calls in the background.

const crypto = require('crypto');
const { generate } = require('../geminiClient');
const { loadBrain } = require('./brainLoader');
const { getConversation, getOrCreateDefaultConversation, appendMessage } = require('./conversationService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('chatService');

// How many review passes each model tier runs, split by whether the message
// was small talk or an actual task. "low" ignores that split entirely — it
// always does exactly one pass, per the product spec.
const MODEL_TIERS = {
  low: { small_talk: 1, task: 1 },
  mid: { small_talk: 2, task: 3 },
  high: { small_talk: 3, task: 5 },
};

const MAX_CLARIFYING_ROUNDS = 2;
const JOB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;

const jobs = new Map();

function createJobId() {
  return crypto.randomBytes(8).toString('hex');
}

function setJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  jobs.set(jobId, { ...existing, ...patch, updatedAt: Date.now() });
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function resolveReviewPasses(model, messageType) {
  const tier = MODEL_TIERS[model] || MODEL_TIERS.high;
  return tier[messageType] || tier.task;
}

// --- Parsing the model's "thinking" response ------------------------------
// The model is instructed (brain/question_protocol.md) to reply with a small
// line-based protocol rather than strict JSON, since that's far more
// reliable across model versions/temperatures on a free-tier model. This
// parser is deliberately forgiving: if the markers are missing, it treats
// the whole response as a plan and proceeds, rather than failing the job.
function parseThinkingResponse(text) {
  if (/DECISION:\s*ASK/i.test(text)) {
    const questionMatch = text.match(/QUESTION:\s*(.+)/i);
    const optionsMatch = text.match(/OPTIONS:\s*(.+)/i);
    const allowCustomMatch = text.match(/ALLOW_CUSTOM:\s*(true|false)/i);
    const question = questionMatch ? questionMatch[1].trim() : 'Could you clarify what you would like?';
    const options = optionsMatch
      ? optionsMatch[1].split('|').map((o) => o.trim()).filter(Boolean)
      : [];
    const allowCustomAnswer = allowCustomMatch ? allowCustomMatch[1].toLowerCase() === 'true' : true;
    return { needsQuestion: true, question, options, allowCustomAnswer };
  }

  const planMatch = text.match(/PLAN:\s*([\s\S]*)/i);
  const plan = planMatch ? planMatch[1].trim() : text.trim();
  const typeMatch = text.match(/TYPE:\s*(SMALL_TALK|TASK)/i);
  const messageType = typeMatch && typeMatch[1].toUpperCase() === 'SMALL_TALK' ? 'small_talk' : 'task';
  return { needsQuestion: false, plan, messageType };
}

function buildHistoryTurns(robloxUserId, conversationId) {
  const conversation = getConversation(robloxUserId, conversationId);
  if (!conversation) return [];
  return conversation.messages.map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    text: h.content,
  }));
}

async function runThinkingStage(job) {
  setJob(job.id, { stage: 'thinking' });
  const brain = loadBrain();
  const historyTurns = buildHistoryTurns(job.robloxUserId, job.conversationId);
  const mustProceed = job.clarifyingRounds >= MAX_CLARIFYING_ROUNDS;

  const instruction = mustProceed
    ? 'A user sent you the message below. You must now proceed and produce a ' +
      'plan for your best possible answer using your own reasonable judgment ' +
      '— do not ask any further clarifying questions, even if some details ' +
      'are still unclear. Always reply with the DECISION: PROCEED / TYPE / ' +
      'PLAN format this time, never DECISION: ASK.\n\n' +
      `User message: ${job.userMessage}`
    : 'A user just sent you the message below. Decide whether you already ' +
      'have enough information to produce a great, complete answer, or ' +
      'whether you genuinely need to ask them one clarifying question ' +
      'first. Do not ask a clarifying question unless it would materially ' +
      'change your answer — prefer a reasonable assumption and proceeding ' +
      'whenever you can. Follow the response protocol from your ' +
      'instructions exactly.\n\n' +
      `User message: ${job.userMessage}`;

  const text = await generate({
    systemInstruction: brain,
    turns: [...historyTurns, { role: 'user', text: instruction }],
    signal: job.abortController.signal,
  });

  return parseThinkingResponse(text);
}

async function runReviewPasses(job, initialPlan, messageType) {
  const totalPasses = resolveReviewPasses(job.model, messageType);
  let plan = initialPlan;
  for (let i = 1; i <= totalPasses; i += 1) {
    setJob(job.id, { stage: 'reviewing', progress: `${i}/${totalPasses}` });
    const brain = loadBrain();
    const instruction =
      `This is review pass ${i} of ${totalPasses}. Here is the current ` +
      `plan/draft for answering the user's request "${job.userMessage}":\n\n` +
      `${plan}\n\n` +
      'Critique it like a meticulous senior Roblox developer reviewing a ' +
      "colleague's work: find anything missing, anything that could be " +
      'cleaner, better organized, more robust, or more idiomatic. Then ' +
      'output the improved plan/draft in full (not just the changes). ' +
      '(Do not use the DECISION/QUESTION protocol here — just output the ' +
      'improved plan/draft text directly.)';

    // Deliberately sequential: each pass builds on the previous one.
    // eslint-disable-next-line no-await-in-loop
    plan = await generate({
      systemInstruction: brain,
      turns: [{ role: 'user', text: instruction }],
      signal: job.abortController.signal,
    });
  }
  return plan;
}

async function runFinalizeStage(job, refinedPlan) {
  setJob(job.id, { stage: 'finalizing' });
  const brain = loadBrain();
  const instruction =
    'Here is your fully refined internal plan for answering ' +
    `"${job.userMessage}":\n\n${refinedPlan}\n\n` +
    'Now write the final response to send directly to the user. Follow ' +
    'your formatting rules exactly. Never mention that you planned, ' +
    'reviewed, or refined anything internally — just give the polished ' +
    'final answer. (Do not use the DECISION/QUESTION/PLAN protocol here — ' +
    'just write the final answer text, ready to send to the user.)';

  return generate({
    systemInstruction: brain,
    turns: [{ role: 'user', text: instruction }],
    signal: job.abortController.signal,
  });
}

async function runPipeline(job) {
  try {
    const thinking = await runThinkingStage(job);

    if (thinking.needsQuestion && job.clarifyingRounds < MAX_CLARIFYING_ROUNDS) {
      setJob(job.id, {
        stage: 'waiting_for_answer',
        question: {
          text: thinking.question,
          options: thinking.options,
          allowCustomAnswer: thinking.allowCustomAnswer,
        },
      });
      return; // paused until POST /chat-answer resumes this job
    }

    const startingPlan = thinking.plan || thinking.question || job.userMessage;
    const refinedPlan = await runReviewPasses(job, startingPlan, thinking.messageType);
    const reply = await runFinalizeStage(job, refinedPlan);

    // The user may have hit Stop while that last Gemini call was already in
    // flight and about to succeed anyway. Discard a late reply rather than
    // resurrecting a job the user already ended.
    if (getJob(job.id).cancelled) {
      logger.info(`Job ${job.id} finished after being stopped; discarding the reply.`);
      return;
    }

    appendMessage(job.robloxUserId, job.conversationId, 'assistant', reply);
    setJob(job.id, { stage: 'done', reply });
  } catch (err) {
    // If this job was cancelled via POST /chat-stop, its abortController was
    // deliberately fired — that's exactly what threw this error. That's not
    // a real failure, so leave the job in its "stopped" stage instead of
    // overwriting it with "error".
    const current = getJob(job.id);
    if (current && current.cancelled) {
      logger.info(`Job ${job.id} stopped by the user mid-pipeline.`);
      return;
    }
    logger.error(`Pipeline failed for job ${job.id}: ${err.message}`, err);
    setJob(job.id, { stage: 'error', error: err.message });
  }
}

function startChatJob({ robloxUserId, message, conversationId }) {
  const conversation = conversationId
    ? getConversation(robloxUserId, conversationId)
    : getOrCreateDefaultConversation(robloxUserId);

  if (!conversation) {
    throw new Error(`No such conversation: ${conversationId}`);
  }

  appendMessage(robloxUserId, conversation.id, 'user', message);

  const jobId = createJobId();
  const job = {
    id: jobId,
    robloxUserId,
    conversationId: conversation.id,
    model: conversation.model,
    userMessage: message,
    clarifyingRounds: 0,
    cancelled: false,
    abortController: new AbortController(),
    stage: 'queued',
  };
  jobs.set(jobId, job);

  runPipeline(job).catch((err) => {
    logger.error(`Unhandled pipeline error for job ${jobId}: ${err.message}`, err);
    setJob(jobId, { stage: 'error', error: err.message });
  });

  return jobId;
}

function answerChatJob({ jobId, answer }) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`No such job: ${jobId}`);
  }
  if (job.stage !== 'waiting_for_answer') {
    throw new Error(`Job ${jobId} is not waiting for an answer (stage: ${job.stage}).`);
  }

  appendMessage(job.robloxUserId, job.conversationId, 'user', answer);

  setJob(jobId, {
    userMessage: `${job.userMessage}\n\n(Clarification: ${answer})`,
    clarifyingRounds: job.clarifyingRounds + 1,
    question: null,
    stage: 'thinking',
  });

  const refreshedJob = getJob(jobId);
  runPipeline(refreshedJob).catch((err) => {
    logger.error(`Unhandled pipeline error resuming job ${jobId}: ${err.message}`, err);
    setJob(jobId, { stage: 'error', error: err.message });
  });
}

// Called by POST /chat-stop. Immediately aborts whatever Gemini request is
// in flight for this job, and marks the job so it can never resume or be
// mistaken for a completed/errored job afterwards.
function cancelJob(jobId) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`No such job: ${jobId}`);
  }
  if (job.abortController) {
    job.abortController.abort();
  }
  setJob(jobId, { cancelled: true, stage: 'stopped' });
}

function getJobStatus(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    conversationId: job.conversationId,
    stage: job.stage,
    progress: job.progress || null,
    question: job.question || null,
    reply: job.reply || null,
    error: job.error || null,
  };
}

// Periodic cleanup so memory doesn't grow forever on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - (job.updatedAt || 0) > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, JOB_SWEEP_INTERVAL_MS);

module.exports = { startChatJob, answerChatJob, cancelJob, getJobStatus };
