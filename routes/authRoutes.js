const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();
const COOKIE_NAME = 'token';
const TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  };
}

function getDemoCredentials() {
  if (
    process.env.NODE_ENV !== 'development' ||
    !process.env.SEED_ADMIN_PASSWORD ||
    !process.env.SEED_EMPLOYEE_PASSWORD
  ) {
    return null;
  }

  return {
    admin: {
      email: process.env.SEED_ADMIN_EMAIL || 'admin@blockaidex.com',
      password: process.env.SEED_ADMIN_PASSWORD,
    },
    employee: {
      email: process.env.SEED_EMPLOYEE_EMAIL || 'user@blockaidex.com',
      password: process.env.SEED_EMPLOYEE_PASSWORD,
    },
  };
}

function renderLogin(res, options = {}) {
  return res.status(options.status || 200).render('login', {
    error: options.error || null,
    activeTab: options.activeTab || 'login',
    signupName: options.signupName || '',
    signupEmail: options.signupEmail || '',
    demoCredentials: getDemoCredentials(),
  });
}

function setAuthCookie(res, user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required for authentication.');
  }

  const token = jwt.sign(
    {
      id: String(user._id),
      sub: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
    },
    secret,
    { expiresIn: '8h' }
  );

  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: TOKEN_LIFETIME_MS,
  });
}

router.get('/login', (req, res) => {
  return renderLogin(res);
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return renderLogin(res, {
        status: 400,
        error: 'Enter your email and password.',
      });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return renderLogin(res, {
        status: 401,
        error: 'The email or password is incorrect.',
      });
    }

    if (!process.env.JWT_SECRET) {
      return renderLogin(res, {
        status: 500,
        error: 'Sign-in is temporarily unavailable. Contact IT support.',
      });
    }

    setAuthCookie(res, user);

    return res.redirect(user.role === 'admin' ? '/admin' : '/chat');
  } catch (error) {
    return next(error);
  }
});

router.post('/signup', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!name || name.length > 100) {
      return renderLogin(res, {
        status: 400,
        activeTab: 'signup',
        signupName: name.slice(0, 100),
        signupEmail: email,
        error: 'Enter your name (up to 100 characters).',
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return renderLogin(res, {
        status: 400,
        activeTab: 'signup',
        signupName: name,
        signupEmail: email.slice(0, 254),
        error: 'Enter a valid work email address.',
      });
    }

    if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      return renderLogin(res, {
        status: 400,
        activeTab: 'signup',
        signupName: name,
        signupEmail: email,
        error: 'Choose a password with at least 12 characters and no more than 72 UTF-8 bytes.',
      });
    }

    if (!process.env.JWT_SECRET) {
      return renderLogin(res, {
        status: 500,
        activeTab: 'signup',
        signupName: name,
        signupEmail: email,
        error: 'Registration is temporarily unavailable. Contact IT support.',
      });
    }

    let user;
    try {
      user = await User.create({
        name,
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'employee',
        tempPassword: false,
      });
    } catch (error) {
      if (error.code === 11000) {
        return renderLogin(res, {
          status: 409,
          activeTab: 'signup',
          signupName: name,
          signupEmail: email,
          error: 'An account already exists for that email address.',
        });
      }
      throw error;
    }

    setAuthCookie(res, user);
    return res.redirect('/chat');
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.redirect('/login');
});

module.exports = router;