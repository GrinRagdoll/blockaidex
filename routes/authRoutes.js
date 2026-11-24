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

router.get('/login', (req, res) => {
  const demoCredentials =
    process.env.NODE_ENV === 'development' &&
    process.env.SEED_ADMIN_PASSWORD &&
    process.env.SEED_EMPLOYEE_PASSWORD
      ? {
          admin: {
            email: process.env.SEED_ADMIN_EMAIL || 'admin@blockaidex.com',
            password: process.env.SEED_ADMIN_PASSWORD,
          },
          employee: {
            email: process.env.SEED_EMPLOYEE_EMAIL || 'user@blockaidex.com',
            password: process.env.SEED_EMPLOYEE_PASSWORD,
          },
        }
      : null;

  res.render('login', { error: null, demoCredentials });
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return res.status(400).render('login', {
        error: 'Enter your email and password.',
        demoCredentials: null,
      });
    }

    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).render('login', {
        error: 'The email or password is incorrect.',
        demoCredentials: null,
      });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).render('login', {
        error: 'Sign-in is temporarily unavailable. Contact IT support.',
        demoCredentials: null,
      });
    }

    const token = jwt.sign(
      {
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

    return res.redirect(user.role === 'admin' ? '/admin' : '/chat');
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.redirect('/login');
});

module.exports = router;