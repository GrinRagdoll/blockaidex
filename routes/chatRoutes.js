const express = require('express');
const ChatSession = require('../models/ChatSession');
const aiService = require('../services/aiService');
const { authenticateToken, requirePageAuth } = require('../middleware/auth');
const { blockPromptInjection, redactPII } = require('../middleware/guardrails');

const router = express.Router();

function getUserId(user) {
  return user.sub || user.id || user._id;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

router.get('/chat', requirePageAuth, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.redirect('/login');
    }

    const chatSession = await ChatSession.findOne({ userId, status: 'active' })
      .sort({ updatedAt: -1 })
      .lean();

    return res.render('chat', { user: req.user, chatSession });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/api/chat',
  authenticateToken,
  blockPromptInjection,
  redactPII,
  async (req, res, next) => {
    try {
      const message = req.body && req.body.message;
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Enter a message to continue.' });
      }
      if (message.length > 10000) {
        return res.status(413).json({ error: 'Messages must be 10,000 characters or fewer.' });
      }

      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      let chatSession = await ChatSession.findOne({ userId, status: 'active' })
        .sort({ updatedAt: -1 });
      if (!chatSession) {
        chatSession = await ChatSession.create({ userId, status: 'active', messages: [] });
      }

      chatSession.messages.push({
        sender: 'user',
        text: message.trim(),
        citations: [],
        latencyMs: 0,
        timestamp: new Date(),
      });
      await chatSession.save();

      const chatSessionId = String(chatSession._id);
      const result = await aiService.generateAnswer(message.trim(), {
        user: req.user,
        chatSessionId,
      });

      chatSession = await ChatSession.findById(chatSession._id);
      if (!chatSession) {
        throw createHttpError(500, 'The chat session could not be reloaded.');
      }

      chatSession.messages.push({
        sender: 'AI',
        text: result.reply,
        citations: result.citations,
        latencyMs: result.latencyMs,
        timestamp: new Date(),
      });
      if (chatSession.status === 'active') {
        chatSession.resolvedBy = 'AI';
      }
      await chatSession.save();

      return res.json({
        ...result,
        chatSessionId,
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;