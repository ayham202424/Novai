// Manages Claude.ai-style multi-conversation chat storage: each Roblox user
// can have many named conversations, each with its own message history and
// its own AI quality tier ("model": low | mid | high). Conversations live in
// the same JSON database used for licenses, under their own top-level key.

const crypto = require('crypto');
const { readDb, writeDb } = require('../db');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('conversationService');

const VALID_MODELS = ['low', 'mid', 'high'];
const MAX_TITLE_LENGTH = 60;
const MAX_MESSAGES_PER_CONVERSATION = 200; // safety cap so one conversation can't grow forever

// Fixed, reserved conversation id used only as a fallback for older plugin
// builds that call /chat without a conversationId. Keeps everything working
// during the rollout instead of breaking existing chats outright.
const DEFAULT_CONVERSATION_ID = 'default';

class ConversationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversationError';
  }
}

function validateModel(model) {
  if (!VALID_MODELS.includes(model)) {
    throw new ConversationError(`"model" must be one of: ${VALID_MODELS.join(', ')} (got: ${model}).`);
  }
}

function validateTitle(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) {
    throw new ConversationError('"title" is required and cannot be empty.');
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ConversationError(`"title" must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function getUserConversations(db, robloxUserId) {
  if (!db.conversations) db.conversations = {};
  const key = String(robloxUserId);
  if (!db.conversations[key]) db.conversations[key] = [];
  return db.conversations[key];
}

// The plugin's conversation list only ever needs the summary shape below —
// never the full message array, so we keep that response small.
function toSummary(conversation) {
  const lastMessage = conversation.messages[conversation.messages.length - 1];
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    lastMessagePreview: lastMessage ? lastMessage.content.slice(0, 80) : null,
  };
}

function createConversation({ robloxUserId, title, model }) {
  validateModel(model);
  const cleanTitle = validateTitle(title);

  const db = readDb();
  const list = getUserConversations(db, robloxUserId);

  const now = Date.now();
  const conversation = {
    id: crypto.randomBytes(8).toString('hex'),
    title: cleanTitle,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  list.push(conversation);
  writeDb(db);

  logger.info(`Created conversation "${cleanTitle}" (${conversation.id}) for robloxUserId=${robloxUserId}, model=${model}`);
  return toSummary(conversation);
}

function listConversations(robloxUserId) {
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  return list.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Returns the FULL conversation (including every message) — used when the
// plugin opens a specific chat and needs to render its whole history.
function getConversation(robloxUserId, conversationId) {
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  return list.find((c) => c.id === conversationId) || null;
}

// Used by the chat pipeline for backward compatibility: if an older plugin
// build calls /chat without a conversationId, everything lands in one fixed,
// auto-created "Chat" conversation per user instead of failing outright.
function getOrCreateDefaultConversation(robloxUserId) {
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  let conversation = list.find((c) => c.id === DEFAULT_CONVERSATION_ID);
  if (!conversation) {
    const now = Date.now();
    conversation = {
      id: DEFAULT_CONVERSATION_ID,
      title: 'Chat',
      model: 'high',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    list.push(conversation);
    writeDb(db);
    logger.info(`Created default conversation for robloxUserId=${robloxUserId}`);
  }
  return conversation;
}

function setConversationModel(robloxUserId, conversationId, model) {
  validateModel(model);
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  const conversation = list.find((c) => c.id === conversationId);
  if (!conversation) {
    throw new ConversationError(`No such conversation: ${conversationId}`);
  }
  conversation.model = model;
  conversation.updatedAt = Date.now();
  writeDb(db);
  logger.info(`Conversation ${conversationId} switched to model=${model}`);
  return toSummary(conversation);
}

function renameConversation(robloxUserId, conversationId, title) {
  const cleanTitle = validateTitle(title);
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  const conversation = list.find((c) => c.id === conversationId);
  if (!conversation) {
    throw new ConversationError(`No such conversation: ${conversationId}`);
  }
  conversation.title = cleanTitle;
  writeDb(db);
  return toSummary(conversation);
}

function deleteConversation(robloxUserId, conversationId) {
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  const index = list.findIndex((c) => c.id === conversationId);
  if (index === -1) {
    throw new ConversationError(`No such conversation: ${conversationId}`);
  }
  list.splice(index, 1);
  db.conversations[String(robloxUserId)] = list;
  writeDb(db);
  logger.info(`Deleted conversation ${conversationId} for robloxUserId=${robloxUserId}`);
}

// Used by the chat pipeline to save each user/assistant turn into the
// correct conversation instead of one flat per-user history.
function appendMessage(robloxUserId, conversationId, role, content) {
  const db = readDb();
  const list = getUserConversations(db, robloxUserId);
  const conversation = list.find((c) => c.id === conversationId);
  if (!conversation) {
    throw new ConversationError(`No such conversation: ${conversationId}`);
  }
  conversation.messages.push({ role, content, timestamp: Date.now() });
  if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  conversation.updatedAt = Date.now();
  writeDb(db);
  return conversation;
}

module.exports = {
  createConversation,
  listConversations,
  getConversation,
  getOrCreateDefaultConversation,
  setConversationModel,
  renameConversation,
  deleteConversation,
  appendMessage,
  ConversationError,
  VALID_MODELS,
  DEFAULT_CONVERSATION_ID,
};
