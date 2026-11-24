const mongoose = require('mongoose');

const documentChunkSchema = new mongoose.Schema(
  {
    sourceFile: {
      type: String,
      required: true,
      trim: true,
    },
    chunkText: {
      type: String,
      required: true,
    },
    embedding: {
      type: [Number],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DocumentChunk', documentChunkSchema);