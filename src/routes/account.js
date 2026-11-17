const express = require('express');
const db = require('../db');
const { verifyPassword, hashPassword } = require('../utils/password');
const { verifyCsrfToken } = require('../middleware/csrf');
const { isDemoAccount } = require('../utils/demo');
const { isTheme } = require('../utils/themes');

const router = express.Router();

router.get('/account/profile', (req, res) => {
  const schools = db.prepare('SELECT * FROM schools ORDER BY name').all();
  res.render('account/profile', { schools, error: null });
});

router.post('/account/profile', verifyCsrfToken, (req, res) => {
  const schools = db.prepare('SELECT * FROM schools ORDER BY name').all();
  const fullName = (req.body.full_name || '').trim();
  const email = (req.body.email || '').trim();

  if (!fullName) {
    return res.status(400).render('account/profile', { schools, error: 'Full name is required.' });
  }

  if (req.currentUser.role === 'student') {
    const schoolId = parseInt(req.body.school_id, 10);
    const classYear = parseInt(req.body.class_year, 10);
    const schoolExists = schools.some((s) => s.id === schoolId);

    if (!schoolExists) {
      return res.status(400).render('account/profile', { schools, error: 'Please select a valid dental school.' });
    }
    if (!Number.isInteger(classYear) || classYear < 2000 || classYear > 2100) {
      return res.status(400).render('account/profile', { schools, error: 'Please enter a valid graduation year.' });
    }

    db.prepare(
      `UPDATE users SET full_name = ?, email = ?, school_id = ?, class_year = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(fullName, email || null, schoolId, classYear, req.currentUser.id);
  } else {
    db.prepare(`UPDATE users SET full_name = ?, email = ?, updated_at = datetime('now') WHERE id = ?`).run(
      fullName,
      email || null,
      req.currentUser.id
    );
  }

  req.flash('success', 'Profile updated.');
  res.redirect('/account/profile');
});

// Theme switcher in the top bar. An empty value goes back to the school's
// own theme.
router.post('/account/theme', verifyCsrfToken, (req, res) => {
  const theme = isTheme(req.body.theme) ? req.body.theme : null;
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.currentUser.id);
  const back = req.body.return_to;
  res.redirect(typeof back === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(back) ? back : '/');
});

router.get('/account/change-password', (req, res) => {
  res.render('account/change-password', { error: null, forced: !!req.currentUser.must_change_password });
});

router.post('/account/change-password', verifyCsrfToken, (req, res) => {
  const { current_password: currentPassword, new_password: newPassword, confirm_password: confirmPassword } = req.body;
  const forced = !!req.currentUser.must_change_password;

  if (isDemoAccount(req.currentUser)) {
    return res.status(400).render('account/change-password', { error: "Demo accounts' passwords can't be changed.", forced });
  }
  if (!verifyPassword(currentPassword || '', req.currentUser.password_hash)) {
    return res.status(400).render('account/change-password', { error: 'Current password is incorrect.', forced });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).render('account/change-password', { error: 'New password must be at least 8 characters.', forced });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).render('account/change-password', { error: 'New passwords do not match.', forced });
  }

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(hashPassword(newPassword), req.currentUser.id);

  req.flash('success', 'Password changed.');
  res.redirect('/');
});

module.exports = router;
