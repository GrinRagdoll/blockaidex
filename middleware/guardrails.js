const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const employeeIdPattern =
  /\b(?:employee\s+(?:id|number)|emp(?:loyee)?[-_ ]?id)\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{2,}\b|\bEMP[-_]?\d{3,}\b|\bE\d{5,}\b/gi;
const phoneCandidatePattern = /(^|[^\w])(\+?\d[\d ().-]*\d)(?=$|[^\w])/g;
const injectionPattern =
  /\bignore\s+(?:all\s+)?previous\s+instructions\b|\breveal\s+(?:the\s+)?system\s+prompt\b|\bbypass\s+(?:the\s+)?rules\b/i;

function redactText(message) {
  if (typeof message !== 'string') {
    return message;
  }

  let redacted = message
    .replace(emailPattern, '[REDACTED_EMAIL]')
    .replace(employeeIdPattern, '[REDACTED_ID]');

  redacted = redacted.replace(
    phoneCandidatePattern,
    (match, prefix, number) => {
      const digitCount = number.replace(/\D/g, '').length;
      return digitCount >= 10 && digitCount <= 15
        ? `${prefix}[REDACTED_PHONE]`
        : match;
    }
  );

  return redacted;
}

function containsPromptInjection(message) {
  return typeof message === 'string' && injectionPattern.test(message);
}

function redactPII(req, res, next) {
  if (req.body && typeof req.body.message === 'string') {
    req.body.message = redactText(req.body.message);
  }
  if (typeof req.attachmentText === 'string') {
    req.attachmentText = redactText(req.attachmentText);
  }

  return next();
}

function blockPromptInjection(req, res, next) {
  const message = req.body && req.body.message;
  const attachmentText = req.attachmentText;
  if (containsPromptInjection(message) || containsPromptInjection(attachmentText)) {
    return res.status(400).json({
      error: 'Security warning',
      message: 'This request contains a prohibited instruction pattern.',
    });
  }

  return next();
}

module.exports = {
  redactPII,
  blockPromptInjection,
  redactText,
  containsPromptInjection,
};