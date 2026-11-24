require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const User = require('./models/User');
const DocumentChunk = require('./models/DocumentChunk');
const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const adminRoutes = require('./routes/adminRoutes');
const ragService = require('./services/ragService');
const { requirePageAuth } = require('./middleware/auth');

const app = express();
const DEFAULT_PORT = 3000;
const SEED_PASSWORD_MIN_LENGTH = 12;

function formatErrorStack(error) {
  const stack = error && error.stack ? error.stack : String(error);
  return stack
    .replace(/(mongodb(?:\+srv)?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s&;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:password|passwd|pwd|token|secret|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(authRoutes);
app.use(chatRoutes);
app.use(adminRoutes);

app.get('/', requirePageAuth, (req, res) => {
  res.redirect(req.user.role === 'admin' ? '/admin' : '/chat');
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode =
    error instanceof multer.MulterError
      ? error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400
      : Number.isInteger(error.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;
  const message =
    statusCode >= 500 ? 'An unexpected server error occurred.' : error.message;

  console.error(`Request failed (${statusCode}):\n${formatErrorStack(error)}`);
  return res.status(statusCode).json({ error: message });
});

async function seedDefaultAccounts() {
  const accounts = [
    {
      name: 'BlockAidex Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@blockaidex.com',
      role: 'admin',
      password: process.env.SEED_ADMIN_PASSWORD,
      passwordVariable: 'SEED_ADMIN_PASSWORD',
    },
    {
      name: 'BlockAidex Employee',
      email: process.env.SEED_EMPLOYEE_EMAIL || 'user@blockaidex.com',
      role: 'employee',
      password: process.env.SEED_EMPLOYEE_PASSWORD,
      passwordVariable: 'SEED_EMPLOYEE_PASSWORD',
    },
  ];

  for (const account of accounts) {
    const email = account.email.trim().toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) {
      continue;
    }

    if (
      typeof account.password !== 'string' ||
      account.password.length < SEED_PASSWORD_MIN_LENGTH
    ) {
      throw new Error(
        `${account.passwordVariable} must be set to a password of at least ${SEED_PASSWORD_MIN_LENGTH} characters to seed ${email}.`
      );
    }

    await User.create({
      name: account.name,
      email,
      role: account.role,
      passwordHash: await bcrypt.hash(account.password, 12),
      tempPassword: false,
    });
  }
}

async function ingestStartupSops() {
  const chunkCount = await DocumentChunk.countDocuments();
  if (chunkCount > 0) {
    return;
  }

  const sopsDirectory = path.join(__dirname, 'sops');
  const files = (await fs.readdir(sopsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const filename of files) {
    const text = await fs.readFile(path.join(sopsDirectory, filename), 'utf8');
    await ragService.ingestDocument(filename, text);
  }
}

async function start() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required.');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required.');
  }

  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port number.');
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    await seedDefaultAccounts();
    await ingestStartupSops();

    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, () => resolve(listener));
      listener.once('error', reject);
    });

    console.log(`BlockAidex listening on port ${port}`);
    return server;
  } catch (error) {
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    }

    throw error;
  }
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`BlockAidex startup failed:\n${formatErrorStack(error)}`);
    if (error.cleanupError) {
      console.error(`MongoDB cleanup failed:\n${formatErrorStack(error.cleanupError)}`);
    }
    process.exitCode = 1;
  });
}

module.exports = { app, start, seedDefaultAccounts, ingestStartupSops, formatErrorStack };