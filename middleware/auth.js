const jwt = require('jsonwebtoken');

function getToken(req) {
  const authorization = req.headers && req.headers.authorization;
  const bearerMatch =
    typeof authorization === 'string' && authorization.match(/^Bearer\s+(.+)$/i);

  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  if (req.cookies && typeof req.cookies.token === 'string') {
    return req.cookies.token;
  }

  const cookieHeader = req.headers && req.headers.cookie;
  if (typeof cookieHeader === 'string') {
    const tokenCookie = cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith('token='));

    if (tokenCookie) {
      return tokenCookie.slice('token='.length);
    }
  }

  return null;
}

function verifyToken(req, res, next, redirectToLogin) {
  const token = getToken(req);
  if (!token) {
    if (redirectToLogin) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Authentication service misconfigured' });
  }

  try {
    const payload = jwt.verify(token, secret);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      if (redirectToLogin) {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    req.user = payload;
    return next();
  } catch (error) {
    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.TokenExpiredError ||
      error instanceof jwt.NotBeforeError
    ) {
      if (redirectToLogin) {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }

    return next(error);
  }
}

function authenticateToken(req, res, next) {
  return verifyToken(req, res, next, false);
}

function requirePageAuth(req, res, next) {
  return verifyToken(req, res, next, true);
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }

  return next();
}

module.exports = { authenticateToken, requirePageAuth, requireAdmin };