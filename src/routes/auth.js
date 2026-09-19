const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { verifyPassword } = require('../utils/password');
const { verifyCsrfToken } = require('../middleware/csrf');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again in a few minutes.',
});

router.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('auth/login', { error: null, username: '' });
});

router.post('/login', loginLimiter, verifyCsrfToken, (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';

  const user = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render('auth/login', { error: 'Incorrect username or password.', username: req.body.username || '' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).render('auth/login', { error: 'Something went wrong. Please try again.', username: '' });
    req.session.userId = user.id;
    res.redirect('/');
  });
});

router.post('/logout', verifyCsrfToken, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
