const { GoogleGenAI } = require('@google/genai');
const DocumentChunk = require('../models/DocumentChunk');

const EMBEDDING_MODEL = 'gemini-embedding-2';
const CHUNK_SIZE = 500;
let aiClient;

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for document embedding.');
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  return aiClient;
}

function splitIntoChunks(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + CHUNK_SIZE / 2) {
        end = boundary;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    start = end;
    while (start < text.length && /\s/.test(text[start])) {
      start += 1;
    }
  }

  return chunks;
}

function readEmbedding(response, description) {
  const values = response.embeddings && response.embeddings[0] && response.embeddings[0].values;
  if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isFinite)) {
    throw new Error(`The embedding service returned an invalid vector for ${description}.`);
  }

  return values;
}

async function ingestDocument(filename, text) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new TypeError('filename must be a non-empty string.');
  }
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string.');
  }

  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) {
    return [];
  }

  const client = getAI();
  const documents = [];
  for (const chunkText of chunks) {
    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: chunkText,
    });

    documents.push({
      sourceFile: filename.trim(),
      chunkText,
      embedding: readEmbedding(response, filename),
    });
  }

  return DocumentChunk.insertMany(documents);
}

function cosineSimilarity(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length === 0 ||
    left.length !== right.length ||
    !left.every(Number.isFinite) ||
    !right.every(Number.isFinite)
  ) {
    return null;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return null;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

async function retrieveContext(query, topK = 3) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TypeError('query must be a non-empty string.');
  }
  if (!Number.isInteger(topK) || topK < 0) {
    throw new TypeError('topK must be a non-negative integer.');
  }
  if (topK === 0) {
    return [];
  }

  const response = await getAI().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: query,
  });
  const queryEmbedding = readEmbedding(response, 'query');
  const chunks = await DocumentChunk.find({ embedding: { $exists: true } }).lean();

  return chunks
    .map((chunk) => ({
      sourceFile: chunk.sourceFile,
      chunkText: chunk.chunkText,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .filter((chunk) => chunk.score !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ sourceFile, chunkText }) => ({ sourceFile, chunkText }));
}

module.exports = { ingestDocument, retrieveContext };