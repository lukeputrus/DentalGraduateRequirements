const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { loadCurrentUser, requireAuth, enforcePasswordChange } = require('./middleware/auth');
const { attachCsrfToken } = require('./middleware/csrf');
const flash = require('./middleware/flash');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const studentRoutes = require('./routes/student');
const assistantRoutes = require('./routes/assistant');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);

app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    name: 'dgr.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(loadCurrentUser);
app.use(attachCsrfToken);
app.use(flash);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Public
app.use(authRoutes);

// Everything below requires a logged-in user, and a completed password
// change if one is pending.
app.use(requireAuth);
app.use(enforcePasswordChange);

app.get('/', (req, res) => {
  res.redirect(req.currentUser.role === 'admin' ? '/admin/dashboard' : '/student/dashboard');
});

app.use(accountRoutes);
app.use('/admin', adminRoutes);
app.use('/student', studentRoutes);
app.use('/student', assistantRoutes);

app.use((req, res) => {
  res.status(404).render('errors/404');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errors/500', { message: process.env.NODE_ENV === 'production' ? null : err.message });
});

module.exports = app;
