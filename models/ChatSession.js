const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: String,
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
    attachmentName: {
      type: String,
      maxlength: 255,
    },
    citations: {
      type: [String],
      default: [],
    },
    latencyMs: {
      type: Number,
      min: 0,
    },
    feedback: {
      type: String,
      enum: ['helpful', 'not_helpful', null],
      default: null,
    },
    pending: {
      type: Boolean,
      default: false,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  }
);

const chatSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'escalated', 'resolved'],
      default: 'active',
      required: true,
    },
    resolvedBy: {
      type: String,
      enum: ['AI', 'Human'],
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatSession', chatSessionSchema);