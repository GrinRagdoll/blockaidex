const express = require('express');
const multer = require('multer');
const path = require('node:path');
const ChatSession = require('../models/ChatSession');
const ragService = require('../services/ragService');
const { requirePageAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension !== '.txt' && extension !== '.md') {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    return callback(null, true);
  },
});

router.get('/admin', requirePageAuth, requireAdmin, async (req, res, next) => {
  try {
    const [queryStats, latencyStats, escalatedCount, escalatedChats] = await Promise.all([
      ChatSession.aggregate([
        { $unwind: '$messages' },
        { $match: { 'messages.sender': 'user' } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            deflected: {
              $sum: {
                $cond: [{ $eq: ['$resolvedBy', 'AI'] }, 1, 0],
              },
            },
          },
        },
      ]),
      ChatSession.aggregate([
        { $unwind: '$messages' },
        { $match: { 'messages.sender': 'AI', 'messages.latencyMs': { $gte: 0 } } },
        { $group: { _id: null, average: { $avg: '$messages.latencyMs' } } },
      ]),
      ChatSession.countDocuments({ status: 'escalated' }),
      ChatSession.find({ status: 'escalated' })
        .sort({ updatedAt: 1 })
        .populate('userId', 'name email')
        .lean(),
    ]);

    const totalQueries = queryStats[0] ? queryStats[0].total : 0;
    const aiDeflectionRate = totalQueries
      ? Math.round((queryStats[0].deflected / totalQueries) * 1000) / 10
      : 0;

    return res.render('admin', {
      user: req.user,
      notice: typeof req.query.notice === 'string' ? req.query.notice : null,
      kpis: {
        totalQueries,
        aiDeflectionRate,
        avgLatencyMs: Math.round(latencyStats[0] ? latencyStats[0].average : 0),
        escalatedTickets: escalatedCount,
      },
      escalatedChats,
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/admin/sops',
  requirePageAuth,
  requireAdmin,
  upload.single('sop'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.redirect('/admin?notice=Choose%20a%20TXT%20or%20Markdown%20file.');
      }

      const text = req.file.buffer.toString('utf8');
      if (!text.trim()) {
        return res.redirect('/admin?notice=The%20uploaded%20SOP%20is%20empty.');
      }

      const filename = path
        .basename(req.file.originalname)
        .replace(/[^A-Za-z0-9._-]/g, '_');
      await ragService.ingestDocument(filename, text);

      return res.redirect('/admin?notice=SOP%20uploaded%20and%20indexed.');
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/admin/chats/:id/reply',
  requirePageAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const reply = typeof req.body.reply === 'string' ? req.body.reply.trim() : '';
      if (!reply) {
        return res.redirect('/admin?notice=Enter%20a%20reply%20before%20sending.');
      }
      if (reply.length > 10000) {
        return res.redirect('/admin?notice=Replies%20must%20be%2010%2C000%20characters%20or%20fewer.');
      }

      const chatSession = await ChatSession.findOne({
        _id: req.params.id,
        status: 'escalated',
      });
      if (!chatSession) {
        return res.redirect('/admin?notice=Escalated%20chat%20not%20found.');
      }

      chatSession.messages.push({
        sender: 'Human',
        text: reply,
        citations: [],
        latencyMs: 0,
        timestamp: new Date(),
      });
      chatSession.status = 'resolved';
      chatSession.resolvedBy = 'Human';
      await chatSession.save();

      return res.redirect('/admin?notice=Reply%20sent%20and%20chat%20resolved.');
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;