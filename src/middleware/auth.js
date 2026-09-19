const db = require('../db');

// Loads the full current user row (fresh from the DB) onto req.currentUser
// for every request, so role/school/class_year edits made by an admin take
// effect immediately without waiting for the session owner to log back in.
function loadCurrentUser(req, res, next) {
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.currentUser = user;
      res.locals.currentUser = user;
    } else {
      req.session.userId = null;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    return res.status(403).render('errors/403');
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'student') {
    return res.status(403).render('errors/403');
  }
  next();
}

// Once a user has must_change_password set, they can't do anything else
// until they change it (applies to the seeded temp admin and to any
// student whose password was just (re)issued by an admin).
function enforcePasswordChange(req, res, next) {
  const allowedPaths = ['/account/change-password', '/logout'];
  if (req.currentUser && req.currentUser.must_change_password && !allowedPaths.includes(req.path)) {
    return res.redirect('/account/change-password');
  }
  next();
}

module.exports = { loadCurrentUser, requireAuth, requireAdmin, requireStudent, enforcePasswordChange };
