const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const ChatSession = require('../models/ChatSession');
const Ticket = require('../models/Ticket');
const User = require('../models/User');

const BCRYPT_ROUNDS = 12;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

class ActionServiceError extends Error {
  constructor(message, publicMessage = message) {
    super(message);
    this.name = 'ActionServiceError';
    this.publicMessage = publicMessage;
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new ActionServiceError('A valid email address is required.');
  }

  return email.trim().toLowerCase();
}

function requireActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new ActionServiceError('An authenticated user is required.', 'Sign in to perform this action.');
  }
}

function authorizeEmail(actor, email) {
  requireActor(actor);
  if (actor.role === 'admin') {
    return;
  }

  if (
    typeof actor.email !== 'string' ||
    actor.email.trim().toLowerCase() !== email
  ) {
    throw new ActionServiceError(
      'The authenticated user cannot act on this account.',
      'You can only perform this action for your own account.'
    );
  }
}

function getActorId(actor) {
  return actor._id || actor.id || actor.userId || actor.sub;
}

async function authorizeSession(actor, session) {
  requireActor(actor);
  if (actor.role === 'admin') {
    return;
  }

  let actorId = getActorId(actor);
  if (!actorId && typeof actor.email === 'string') {
    const user = await User.findOne({ email: actor.email.trim().toLowerCase() }).select('_id').lean();
    actorId = user && user._id;
  }

  if (!actorId || String(session.userId) !== String(actorId)) {
    throw new ActionServiceError(
      'The authenticated user cannot act on this chat session.',
      'You can only escalate your own chat session.'
    );
  }
}

async function postWebhook(payload) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new ActionServiceError(
      'WEBHOOK_URL is not configured.',
      'The action could not be completed because secure notification is unavailable. Contact IT support.'
    );
  }

  let endpoint;
  try {
    endpoint = new URL(webhookUrl);
  } catch {
    throw new ActionServiceError(
      'WEBHOOK_URL is invalid.',
      'The action could not be completed because secure notification is unavailable. Contact IT support.'
    );
  }
  if (endpoint.protocol !== 'https:') {
    throw new ActionServiceError(
      'WEBHOOK_URL must use HTTPS.',
      'The action could not be completed because secure notification is unavailable. Contact IT support.'
    );
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
  } catch {
    throw new ActionServiceError(
      'Secure webhook delivery failed.',
      'The action was saved, but secure notification failed. Contact IT support.'
    );
  }

  if (!response.ok) {
    throw new ActionServiceError(
      `Secure webhook returned HTTP ${response.status}.`,
      'The action was saved, but secure notification failed. Contact IT support.'
    );
  }
}

async function resetUserPassword(email, actor) {
  const normalizedEmail = normalizeEmail(email);
  authorizeEmail(actor, normalizedEmail);

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    throw new ActionServiceError(
      'No user account matched the requested email.',
      'The account could not be reset. Contact IT support.'
    );
  }

  const temporaryPassword = crypto.randomBytes(24).toString('base64url');
  const previousPasswordHash = user.passwordHash;
  const previousTempPassword = user.tempPassword;
  const newPasswordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
  user.passwordHash = newPasswordHash;
  user.tempPassword = true;
  await user.save();

  try {
    await postWebhook({
      event: 'user.password_reset',
      userEmail: normalizedEmail,
      temporaryPassword,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    });
  } catch {
    let rollback;
    try {
      rollback = await User.updateOne(
        { _id: user._id, passwordHash: newPasswordHash },
        {
          $set: {
            passwordHash: previousPasswordHash,
            tempPassword: previousTempPassword,
          },
        }
      );
    } catch {
      throw new ActionServiceError(
        'Secure password delivery failed and the password reset could not be rolled back.',
        'Secure delivery failed and the password could not be safely restored. Contact IT immediately.'
      );
    }

    if (rollback.modifiedCount !== 1) {
      throw new ActionServiceError(
        'Secure password delivery failed and the password changed concurrently.',
        'Secure delivery failed while the account changed. Contact IT immediately.'
      );
    }

    throw new ActionServiceError(
      'Secure password delivery failed; the prior password was restored.',
      'The password was not changed because secure delivery failed. Try again or contact IT support.'
    );
  }

  return {
    success: true,
    userEmail: normalizedEmail,
    message: 'A temporary password was delivered through the secure IT channel. It must be changed at next sign-in.',
  };
}

async function createSupportTicket(userEmail, issue, priority, actor) {
  const normalizedEmail = normalizeEmail(userEmail);
  authorizeEmail(actor, normalizedEmail);
  if (typeof issue !== 'string' || !issue.trim()) {
    throw new ActionServiceError('issue must be a non-empty string.');
  }

  const normalizedPriority = typeof priority === 'string' ? priority.trim().toLowerCase() : '';
  if (!VALID_PRIORITIES.includes(normalizedPriority)) {
    throw new ActionServiceError(`priority must be one of: ${VALID_PRIORITIES.join(', ')}.`);
  }

  const ticketId = `TKT-${crypto.randomUUID()}`;
  const ticket = await Ticket.create({
    ticketId,
    userEmail: normalizedEmail,
    issueSummary: issue.trim(),
    priority: normalizedPriority,
    status: 'open',
    createdByAI: true,
    webhookDelivered: false,
  });

  try {
    await postWebhook({
      event: 'support.ticket_created',
      ticketId,
      userEmail: normalizedEmail,
      issueSummary: ticket.issueSummary,
      priority: ticket.priority,
      status: ticket.status,
      createdByAI: ticket.createdByAI,
      createdAt: ticket.createdAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof ActionServiceError) {
      throw new ActionServiceError(
        `Ticket ${ticketId} was saved, but webhook delivery failed.`,
        `Ticket ${ticketId} was saved, but IT notification failed. Contact IT support if you do not receive an update.`
      );
    }
    throw error;
  }

  ticket.webhookDelivered = true;
  await ticket.save();

  return { success: true, ticketId, status: ticket.status };
}

async function escalateToHuman(chatSessionId, reason, actor) {
  if (typeof chatSessionId !== 'string' || !chatSessionId.trim()) {
    throw new ActionServiceError('chatSessionId must be a non-empty string.');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new ActionServiceError('reason must be a non-empty string.');
  }

  const session = await ChatSession.findById(chatSessionId.trim());
  if (!session) {
    throw new ActionServiceError(
      'Chat session was not found.',
      'This chat session could not be escalated. Contact IT support.'
    );
  }

  await authorizeSession(actor, session);
  session.status = 'escalated';
  session.resolvedBy = 'Human';
  session.messages.push({
    sender: 'system',
    text: `Escalation reason: ${reason.trim()}`,
    citations: [],
    timestamp: new Date(),
  });
  await session.save();

  return { success: true, chatSessionId: String(session._id), status: session.status };
}

module.exports = {
  resetUserPassword,
  createSupportTicket,
  escalateToHuman,
  ActionServiceError,
};