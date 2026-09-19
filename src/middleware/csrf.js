const crypto = require('crypto');

// Minimal session-bound CSRF token (double-submit pattern): a token is
// generated per session and must be echoed back on every state-changing
// form post via a hidden _csrf field.
function attachCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrfToken(req, res, next) {
  const submitted = req.body && req.body._csrf;
  if (!submitted || submitted !== req.session.csrfToken) {
    return res.status(403).render('errors/403', { message: 'Your session expired or the form was resubmitted. Please go back and try again.' });
  }
  next();
}

module.exports = { attachCsrfToken, verifyCsrfToken };
