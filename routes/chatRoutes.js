const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const ChatSession = require('../models/ChatSession');
const aiService = require('../services/aiService');
const { authenticateToken, requirePageAuth } = require('../middleware/auth');
const { blockPromptInjection, redactPII } = require('../middleware/guardrails');

const router = express.Router();
const ALLOWED_TONES = new Set(['Friendly', 'Professional', 'Concise']);
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
  userContext = ''
) {
  const chatSessionId = String(sessionId);
  const result = await aiService.generateAnswer(message, {
    user,
    chatSessionId,
    tone,
    allowActions,
    userContext,
  });
  const chatSession = await ChatSession.findById(sessionId);
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
  return { result, chatSession };
}

function getMessageIndex(value) {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
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
        tone
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
        false
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

      chatSession.messages.push({
        sender: 'user',
        text: message,
        attachmentName: req.attachmentName,
        citations: [],
        latencyMs: 0,
        timestamp: new Date(),
      });
      await chatSession.save();

      const { result, chatSession: updatedSession } = await generateAndSaveReply(
        chatSession._id,
        message,
        req.user,
        tone,
        true,
        req.attachmentText || ''
      );

      return res.json({
        ...result,
        chatSessionId: String(updatedSession._id),
        status: updatedSession.status,
        userMessageText: message,
        attachmentName: req.attachmentName,
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;