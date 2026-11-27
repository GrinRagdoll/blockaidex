const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const ChatSession = require('../models/ChatSession');
const aiService = require('../services/aiService');
const actionService = require('../services/actionService');
const { authenticateToken, requirePageAuth } = require('../middleware/auth');
const { blockPromptInjection, redactPII, redactText } = require('../middleware/guardrails');

const router = express.Router();
const ALLOWED_TONES = new Set(['Friendly', 'Professional', 'Concise']);
const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.pdf']);
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHARACTERS = 20000;

function getUserId(user) {
  return user.sub || user.id || user._id;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const uploadAttachment = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_SIZE,
    files: 1,
    fields: 10,
    fieldSize: 10000,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
      return callback(createHttpError(415, 'Attach a .txt, .md, .csv, or .pdf file.'));
    }
    return callback(null, true);
  },
});

function getSafeAttachmentName(originalName) {
  const filename = path.posix
    .basename(String(originalName).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 255);
  return filename || 'attachment';
}

async function extractAttachmentText(req, res, next) {
  if (!req.file) {
    return next();
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  let text;
  try {
    if (extension === '.pdf') {
      const pdfHeader = req.file.buffer.subarray(0, 1024).toString('latin1');
      if (!pdfHeader.includes('%PDF-')) {
        return next(createHttpError(400, 'The attached PDF file is invalid.'));
      }

      const parser = new PDFParse({ data: req.file.buffer });
      try {
        const result = await parser.getText();
        text = result.text || '';
      } finally {
        await parser.destroy();
      }
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer);
      } catch {
        return next(createHttpError(400, 'The attached text file must use UTF-8 encoding.'));
      }
    }
  } catch {
    return next(createHttpError(
      400,
      'The attached file could not be read. Use a valid, unencrypted PDF or UTF-8 text file.'
    ));
  }

  const attachmentText = (typeof text === 'string' ? text : '').replace(/\0/g, '').trim();
  if (!attachmentText) {
    return next(createHttpError(400, 'The attached file contains no extractable text.'));
  }
  if (attachmentText.length > MAX_ATTACHMENT_CHARACTERS) {
    return next(createHttpError(
      413,
      `The extracted file text must be ${MAX_ATTACHMENT_CHARACTERS} characters or fewer.`
    ));
  }

  req.attachmentText = attachmentText;
  req.attachmentName = getSafeAttachmentName(req.file.originalname);
  return next();
}

function getTone(body) {
  const tone = body && body.tone;
  if (tone === undefined) {
    return 'Friendly';
  }
  return typeof tone === 'string' && ALLOWED_TONES.has(tone) ? tone : null;
}

function validateMessage(message) {
  if (typeof message !== 'string' || !message.trim()) {
    return { statusCode: 400, error: 'Enter a message to continue.' };
  }
  if (message.length > 10000) {
    return { statusCode: 413, error: 'Messages must be 10,000 characters or fewer.' };
  }
  return { message: message.trim() };
}

async function findOwnedSession(sessionId, userId) {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    return null;
  }
  return ChatSession.findOne({ _id: sessionId, userId });
}

async function generateAndSaveReply(
  sessionId,
  message,
  user,
  tone,
  allowActions = true,
  userContext = '',
  history = [],
  pendingMessageId = null,
  pendingUserMessageId = null
) {
  const chatSessionId = String(sessionId);
  const result = await aiService.generateAnswer(message, {
    user,
    chatSessionId,
    tone,
    allowActions,
    userContext,
    history,
  });
  const chatSession = await ChatSession.findById(sessionId);
  if (!chatSession) {
    throw createHttpError(500, 'The chat session could not be reloaded.');
  }

  if (pendingMessageId) {
    const pendingMessage = chatSession.messages.id(pendingMessageId);
    if (!pendingMessage || !pendingMessage.pending) {
      throw createHttpError(409, 'The pending assistant reply could not be found.');
    }
    pendingMessage.text = result.reply;
    pendingMessage.citations = result.citations;
    pendingMessage.latencyMs = result.latencyMs;
    pendingMessage.pending = false;
  } else {
    chatSession.messages.push({
      sender: 'AI',
      text: result.reply,
      citations: result.citations,
      latencyMs: result.latencyMs,
      timestamp: new Date(),
    });
  }
  if (pendingUserMessageId) {
    const pendingUserMessage = chatSession.messages.id(pendingUserMessageId);
    if (pendingUserMessage) {
      pendingUserMessage.pending = false;
    }
  }
  if (chatSession.status === 'active') {
    chatSession.resolvedBy = 'AI';
  }
  await chatSession.save();
  return { result, chatSession };
}

async function finishPendingReply(options) {
  const {
    sessionId,
    userMessageId,
    assistantMessageId,
    message,
    user,
    tone,
    userContext,
    history,
  } = options;
  try {
    await generateAndSaveReply(
      sessionId,
      message,
      user,
      tone,
      true,
      userContext,
      history,
      assistantMessageId,
      userMessageId
    );
  } catch (error) {
    console.error('Background assistant response failed:', error);
    let chatSession;
    try {
      chatSession = await ChatSession.findById(sessionId);
    } catch (loadError) {
      console.error('The pending chat session could not be reloaded after generation failed:', loadError);
      return;
    }
    if (!chatSession) {
      console.error(`Pending chat session ${String(sessionId)} was not found after generation failed.`);
      return;
    }

    const assistantMessage = chatSession.messages.id(assistantMessageId);
    const userMessage = chatSession.messages.id(userMessageId);
    if (assistantMessage && assistantMessage.pending) {
      assistantMessage.text = 'Sorry, I could not complete that response. Please try again.';
      assistantMessage.pending = false;
    }
    if (userMessage) {
      userMessage.pending = false;
    }
    try {
      await chatSession.save();
    } catch (saveError) {
      console.error('The assistant failure state could not be saved:', saveError);
    }
  }
}

function getMessageIndex(value) {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

function getConversationHistory(chatSession, currentMessageIndex) {
  return chatSession.messages
    .slice(Math.max(0, currentMessageIndex - 5), currentMessageIndex)
    .map((message) => ({ sender: message.sender, text: message.text }));
}

router.get('/chat', requirePageAuth, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.redirect('/login');
    }

    const chatSession = await ChatSession.findOne({ userId })
      .sort({ updatedAt: -1 })
      .select('_id status')
      .lean();

    return res.render('chat', { user: req.user, chatSession });
  } catch (error) {
    return next(error);
  }
});

router.get('/chat/:id', requirePageAuth, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.redirect('/login');
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.redirect('/chat');
    }

    const chatSession = await ChatSession.findOne({
      _id: req.params.id,
      userId,
    })
      .select('_id status')
      .lean();
    if (!chatSession) {
      return res.redirect('/chat');
    }

    return res.render('chat', { user: req.user, chatSession });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/chat/sessions', authenticateToken, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sessions = await ChatSession.find({ userId })
      .sort({ updatedAt: -1 })
      .select('_id status updatedAt messages.sender messages.text')
      .lean();

    return res.json({
      sessions: sessions.map((session) => {
        const firstUserMessage = session.messages.find(
          (message) => message.sender === 'user' && message.text
        );
        const title = firstUserMessage
          ? firstUserMessage.text.replace(/\s+/g, ' ').trim().slice(0, 64)
          : 'New chat';

        return {
          id: String(session._id),
          title: title || 'New chat',
          status: session.status,
          updatedAt: session.updatedAt,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/chat/sessions', authenticateToken, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const session = await ChatSession.create({
      userId,
      status: 'active',
      messages: [],
    });
    return res.status(201).json({
      id: String(session._id),
      status: session.status,
    });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/api/chat/sessions/:sessionId',
  authenticateToken,
  async (req, res, next) => {
    try {
      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!mongoose.Types.ObjectId.isValid(req.params.sessionId)) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      const session = await ChatSession.findOne({
        _id: req.params.sessionId,
        userId,
      })
        .select('_id status messages')
        .lean();
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      return res.json({
        id: String(session._id),
        status: session.status,
        messages: session.messages,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get('/api/chat/:sessionId', authenticateToken, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const session = await findOwnedSession(req.params.sessionId, userId);
    if (!session) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    return res.json({
      id: String(session._id),
      status: session.status,
      messages: session.messages,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/tickets/quick', authenticateToken, async (req, res, next) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const body = req.body || {};
    const issue = typeof body.issue === 'string' ? redactText(body.issue).trim() : '';
    const priority = typeof body.priority === 'string'
      ? body.priority.trim().toLowerCase()
      : '';
    if (!issue) {
      return res.status(400).json({ error: 'Enter a short description of the issue.' });
    }
    if (issue.length > 10000) {
      return res.status(413).json({
        error: 'Issue descriptions must be 10,000 characters or fewer.',
      });
    }
    if (!ALLOWED_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: 'Choose low, medium, high, or urgent priority.' });
    }

    const requestedSessionId = body.sessionId;
    let chatSession;
    if (requestedSessionId !== undefined && requestedSessionId !== null) {
      if (
        typeof requestedSessionId !== 'string' ||
        !mongoose.Types.ObjectId.isValid(requestedSessionId)
      ) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      chatSession = await findOwnedSession(requestedSessionId, userId);
      if (!chatSession) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
    } else {
      chatSession = await ChatSession.findOne({ userId, status: 'active' }).sort({ updatedAt: -1 });
      if (!chatSession) {
        chatSession = await ChatSession.create({ userId, status: 'active', messages: [] });
      }
    }

    if (chatSession.status !== 'active') {
      return res.status(409).json({
        error: 'This conversation is closed. Start a new chat to continue.',
      });
    }
    if (chatSession.messages.some((message) => message.pending)) {
      return res.status(409).json({
        error: 'Wait for the current assistant response before creating a ticket.',
      });
    }

    const ticket = await actionService.createSupportTicket(
      req.user.email,
      issue,
      priority,
      req.user
    );
    chatSession.messages.push({
      sender: 'AI',
      text: `Your support ticket was created. Ticket ID: ${ticket.ticketId}`,
      citations: [],
      latencyMs: 0,
      timestamp: new Date(),
    });
    await chatSession.save();

    return res.status(201).json({
      ticketId: ticket.ticketId,
      chatSessionId: String(chatSession._id),
      status: chatSession.status,
      messages: chatSession.messages,
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/api/chat/:sessionId/messages/:messageId/feedback',
  authenticateToken,
  async (req, res, next) => {
    try {
      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const feedback = req.body && req.body.feedback;
      if (feedback !== null && feedback !== 'helpful' && feedback !== 'not_helpful') {
        return res.status(400).json({
          error: 'Feedback must be helpful, not_helpful, or null.',
        });
      }
      if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) {
        return res.status(404).json({ error: 'Assistant message not found.' });
      }

      const chatSession = await findOwnedSession(req.params.sessionId, userId);
      if (!chatSession) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      const message = chatSession.messages.id(req.params.messageId);
      if (!message || message.sender !== 'AI') {
        return res.status(404).json({ error: 'Assistant message not found.' });
      }

      message.feedback = feedback;
      await chatSession.save();
      return res.json({ feedback: message.feedback });
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  '/api/chat/:sessionId',
  authenticateToken,
  async (req, res, next) => {
    try {
      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!mongoose.Types.ObjectId.isValid(req.params.sessionId)) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }

      const session = await ChatSession.findById(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      if (String(session.userId) !== String(req.user.id || userId)) {
        return res.status(403).json({ error: 'You cannot delete this conversation.' });
      }

      await session.deleteOne();
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  '/api/chat/:sessionId/messages/:messageIndex',
  authenticateToken,
  blockPromptInjection,
  redactPII,
  async (req, res, next) => {
    try {
      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const tone = getTone(req.body);
      if (!tone) {
        return res.status(400).json({ error: 'Choose Friendly, Professional, or Concise tone.' });
      }
      const validatedMessage = validateMessage(req.body && req.body.message);
      if (validatedMessage.error) {
        return res.status(validatedMessage.statusCode).json({ error: validatedMessage.error });
      }
      const messageIndex = getMessageIndex(req.params.messageIndex);
      if (messageIndex === null) {
        return res.status(400).json({ error: 'The message index is invalid.' });
      }

      const chatSession = await findOwnedSession(req.params.sessionId, userId);
      if (!chatSession) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      if (chatSession.status !== 'active') {
        return res.status(409).json({
          error: 'This conversation is closed. Start a new chat to continue.',
        });
      }
      if (chatSession.messages.some((message) => message.pending)) {
        return res.status(409).json({
          error: 'Wait for the current assistant response before editing a message.',
        });
      }
      const userMessage = chatSession.messages[messageIndex];
      if (!userMessage || userMessage.sender !== 'user') {
        return res.status(400).json({ error: 'Only your own messages can be edited.' });
      }

      chatSession.messages.splice(messageIndex + 1);
      userMessage.text = validatedMessage.message;
      userMessage.attachmentName = null;
      userMessage.citations = [];
      userMessage.latencyMs = 0;
      userMessage.timestamp = new Date();
      await chatSession.save();

      const { result, chatSession: updatedSession } = await generateAndSaveReply(
        chatSession._id,
        validatedMessage.message,
        req.user,
        tone,
        true,
        '',
        getConversationHistory(chatSession, messageIndex)
      );
      return res.json({
        ...result,
        chatSessionId: String(updatedSession._id),
        status: updatedSession.status,
        messages: updatedSession.messages,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/api/chat/:sessionId/messages/:messageIndex/regenerate',
  authenticateToken,
  async (req, res, next) => {
    try {
      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const tone = getTone(req.body);
      if (!tone) {
        return res.status(400).json({ error: 'Choose Friendly, Professional, or Concise tone.' });
      }
      const messageIndex = getMessageIndex(req.params.messageIndex);
      if (messageIndex === null) {
        return res.status(400).json({ error: 'The message index is invalid.' });
      }

      const chatSession = await findOwnedSession(req.params.sessionId, userId);
      if (!chatSession) {
        return res.status(404).json({ error: 'Conversation not found.' });
      }
      if (chatSession.status !== 'active') {
        return res.status(409).json({
          error: 'This conversation is closed. Start a new chat to continue.',
        });
      }
      if (chatSession.messages.some((message) => message.pending)) {
        return res.status(409).json({
          error: 'Wait for the current assistant response before regenerating a reply.',
        });
      }
      const assistantMessage = chatSession.messages[messageIndex];
      if (!assistantMessage || assistantMessage.sender !== 'AI') {
        return res.status(400).json({ error: 'Only AI messages can be regenerated.' });
      }

      let userMessageIndex = messageIndex - 1;
      while (
        userMessageIndex >= 0 &&
        chatSession.messages[userMessageIndex].sender !== 'user'
      ) {
        userMessageIndex -= 1;
      }
      if (userMessageIndex < 0) {
        return res.status(400).json({ error: 'The original user message was not found.' });
      }
      if (chatSession.messages[userMessageIndex].attachmentName) {
        return res.status(409).json({
          error: 'File contents are temporary and cannot be regenerated. Send the request again with the file attached.',
        });
      }

      const prompt = chatSession.messages[userMessageIndex].text;
      const validatedMessage = validateMessage(prompt);
      if (validatedMessage.error) {
        return res.status(validatedMessage.statusCode).json({ error: validatedMessage.error });
      }
      chatSession.messages.splice(userMessageIndex + 1);
      await chatSession.save();

      const { result, chatSession: updatedSession } = await generateAndSaveReply(
        chatSession._id,
        validatedMessage.message,
        req.user,
        tone,
        false,
        '',
        getConversationHistory(chatSession, userMessageIndex)
      );
      return res.json({
        ...result,
        chatSessionId: String(updatedSession._id),
        status: updatedSession.status,
        messages: updatedSession.messages,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/api/chat',
  authenticateToken,
  uploadAttachment.single('attachment'),
  extractAttachmentText,
  blockPromptInjection,
  redactPII,
  async (req, res, next) => {
    try {
      const validatedMessage = validateMessage(req.body && req.body.message);
      if (validatedMessage.error) {
        return res.status(validatedMessage.statusCode).json({ error: validatedMessage.error });
      }
      const tone = getTone(req.body);
      if (!tone) {
        return res.status(400).json({ error: 'Choose Friendly, Professional, or Concise tone.' });
      }
      const message = validatedMessage.message;

      const userId = getUserId(req.user);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const requestedSessionId = req.body && req.body.sessionId;
      let chatSession;
      if (requestedSessionId !== undefined && requestedSessionId !== null) {
        if (
          typeof requestedSessionId !== 'string' ||
          !mongoose.Types.ObjectId.isValid(requestedSessionId)
        ) {
          return res.status(404).json({ error: 'Conversation not found.' });
        }

        chatSession = await ChatSession.findOne({
          _id: requestedSessionId,
          userId,
        });
        if (!chatSession) {
          return res.status(404).json({ error: 'Conversation not found.' });
        }
        if (chatSession.status !== 'active') {
          return res.status(409).json({
            error: 'This conversation is closed. Start a new chat to continue.',
          });
        }
      } else {
        chatSession = await ChatSession.findOne({ userId, status: 'active' })
          .sort({ updatedAt: -1 });
        if (!chatSession) {
          chatSession = await ChatSession.create({
            userId,
            status: 'active',
            messages: [],
          });
        }
      }

      if (chatSession.messages.some((chatMessage) => chatMessage.pending)) {
        return res.status(409).json({
          error: 'Wait for the current assistant response before sending another message.',
        });
      }

      const history = getConversationHistory(chatSession, chatSession.messages.length);
      chatSession.messages.push({
        sender: 'user',
        text: message,
        attachmentName: req.attachmentName,
        citations: [],
        latencyMs: 0,
        pending: true,
        timestamp: new Date(),
      });
      const userMessage = chatSession.messages[chatSession.messages.length - 1];
      chatSession.messages.push({
        sender: 'AI',
        text: 'Thinking…',
        citations: [],
        pending: true,
        timestamp: new Date(),
      });
      const assistantMessage = chatSession.messages[chatSession.messages.length - 1];
      await chatSession.save();

      res.status(202).json({
        chatSessionId: String(chatSession._id),
        status: chatSession.status,
        messages: chatSession.messages,
        userMessageText: message,
        attachmentName: req.attachmentName,
      });
      setImmediate(() => {
        void finishPendingReply({
          sessionId: chatSession._id,
          userMessageId: userMessage._id,
          assistantMessageId: assistantMessage._id,
          message,
          user: req.user,
          tone,
          userContext: req.attachmentText || '',
          history,
        });
      });
      return undefined;
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;