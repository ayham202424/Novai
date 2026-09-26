const express = require('express');
const {
  createConversation,
  listConversations,
  getConversation,
  setConversationModel,
  renameConversation,
  deleteConversation,
  ConversationError,
} = require('../services/conversationService');
const { createScopedLogger } = require('../logger');

const logger = createScopedLogger('conversations');
const router = express.Router();

// POST /conversations — create a new named conversation with a chosen model tier.
// Body: { robloxUserId, title, model }
router.post('/conversations', (req, res) => {
  const { robloxUserId, title, model } = req.body || {};
  if (!robloxUserId) {
    return res.status(400).json({ error: 'robloxUserId is required.' });
  }
  try {
    const conversation = createConversation({ robloxUserId, title, model });
    logger.info(`robloxUserId=${robloxUserId} created conversation "${conversation.title}" (${conversation.id})`);
    return res.json(conversation);
  } catch (err) {
    if (err instanceof ConversationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`Failed to create conversation for robloxUserId=${robloxUserId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while creating the conversation.' });
  }
});

// GET /conversations?robloxUserId=... — list all conversations, newest first.
router.get('/conversations', (req, res) => {
  const robloxUserId = req.query.robloxUserId;
  if (!robloxUserId) {
    return res.status(400).json({ error: 'robloxUserId query parameter is required.' });
  }
  try {
    const conversations = listConversations(robloxUserId);
    return res.json({ conversations });
  } catch (err) {
    logger.error(`Failed to list conversations for robloxUserId=${robloxUserId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while listing conversations.' });
  }
});

// GET /conversation?robloxUserId=...&conversationId=... — full message history for one conversation.
router.get('/conversation', (req, res) => {
  const { robloxUserId, conversationId } = req.query;
  if (!robloxUserId || !conversationId) {
    return res.status(400).json({ error: 'robloxUserId and conversationId query parameters are both required.' });
  }
  try {
    const conversation = getConversation(robloxUserId, String(conversationId));
    if (!conversation) {
      return res.status(404).json({ error: 'No such conversation.' });
    }
    return res.json(conversation);
  } catch (err) {
    logger.error(`Failed to load conversation ${conversationId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while loading the conversation.' });
  }
});

// PATCH /conversation — change a conversation's model tier and/or rename it.
// Body: { robloxUserId, conversationId, model?, title? }
router.patch('/conversation', (req, res) => {
  const { robloxUserId, conversationId, model, title } = req.body || {};
  if (!robloxUserId || !conversationId) {
    return res.status(400).json({ error: 'robloxUserId and conversationId are both required.' });
  }
  if (!model && !title) {
    return res.status(400).json({ error: 'Provide "model" and/or "title" to update.' });
  }
  try {
    let result;
    if (model) result = setConversationModel(robloxUserId, conversationId, model);
    if (title) result = renameConversation(robloxUserId, conversationId, title);
    return res.json(result);
  } catch (err) {
    if (err instanceof ConversationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`Failed to update conversation ${conversationId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while updating the conversation.' });
  }
});

// DELETE /conversation?robloxUserId=...&conversationId=... — permanently remove a conversation.
router.delete('/conversation', (req, res) => {
  const { robloxUserId, conversationId } = req.query;
  if (!robloxUserId || !conversationId) {
    return res.status(400).json({ error: 'robloxUserId and conversationId query parameters are both required.' });
  }
  try {
    deleteConversation(robloxUserId, String(conversationId));
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof ConversationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error(`Failed to delete conversation ${conversationId}: ${err.message}`, err);
    return res.status(500).json({ error: 'Internal error while deleting the conversation.' });
  }
});

module.exports = router;
