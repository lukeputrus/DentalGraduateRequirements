const express = require('express');
const db = require('../db');
const { verifyCsrfToken } = require('../middleware/csrf');
const { DEMO_ACCOUNTS, isDemoAccount } = require('../utils/demo');

const router = express.Router();

// The role switcher in the top bar. Only exists in demo mode, and only
// moves between the shared demo accounts (whose passwords are public on
// the login page anyway), so it grants nothing a visitor couldn't already
// do by logging in.
router.post('/demo/view-as', verifyCsrfToken, (req, res) => {
  if (!isDemoAccount(req.currentUser)) return res.status(403).render('errors/403');
  const target = DEMO_ACCOUNTS.find((a) => a.username === req.body.username);
  const user = target && db.prepare('SELECT id FROM users WHERE username = ?').get(target.username);
  if (!user) return res.redirect('/');
  req.session.regenerate((err) => {
    if (err) return res.redirect('/');
    req.session.userId = user.id;
    res.redirect('/');
  });
});

module.exports = router;
