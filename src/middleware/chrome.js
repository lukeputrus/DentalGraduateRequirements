const db = require('../db');
const { THEMES, resolveTheme } = require('../utils/themes');
const { isDemoAccount, DEMO_ACCOUNTS } = require('../utils/demo');
const { getStudentCompetencies, summarize, weeksToGraduation } = require('../utils/competencies');

const FILLER = new Set(['university', 'of', 'the', 'school', 'college', 'dentistry', 'dental', 'medicine', 'and', 'health', 'sciences', 'at', 'in']);

// Two-letter mark for the masthead logo slot. A real institutional logo
// would drop in here; shipping one needs the school's permission.
function initials(name) {
  if (!name) return 'DG';
  const words = name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase()));
  const letters = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return letters || name.slice(0, 2).toUpperCase();
}

// Everything the page chrome (utility bar, masthead, nav) needs: theme,
// school, role switcher and the student's headline numbers.
function loadChrome(req, res, next) {
  const user = req.currentUser;
  const school = user && user.school_id ? db.prepare('SELECT * FROM schools WHERE id = ?').get(user.school_id) : null;
  res.locals.school = school;
  res.locals.theme = resolveTheme(user, school);
  res.locals.schoolTheme = school && school.theme;
  res.locals.themes = THEMES;
  res.locals.currentPath = req.path;
  res.locals.markInitials = initials(school && school.name);
  res.locals.roleSwitch = isDemoAccount(user) ? DEMO_ACCOUNTS : null;
  res.locals.chromeStats = null;
  if (user && user.role === 'student' && user.school_id && user.class_year && !user.must_change_password) {
    const summary = summarize(getStudentCompetencies(user));
    res.locals.chromeStats = { passed: summary.passed, total: summary.total, weeks: weeksToGraduation(user.class_year) };
  }
  next();
}

module.exports = { loadChrome, initials };
