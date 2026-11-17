const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireStudent } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const {
  STATUS_DISPLAY,
  getStudentCompetencies,
  groupByCategory,
  summarize,
  setItemProgress,
  setProcedureProgress,
  urgency,
  todayISO,
  isISODate,
  graduationDate,
  weeksToGraduation,
  saveNotes,
  getNotes,
} = require('../utils/competencies');
const {
  DOCUMENT_KINDS,
  MAX_DOCUMENT_BYTES,
  documentExtension,
  saveDocument,
  listDocuments,
  deleteDocument,
  sendDocument,
  formatSize,
} = require('../utils/documents');
const { listGoals, addGoal } = require('../utils/goals');

const router = express.Router();

router.use(requireStudent);

// Every page except the profile needs a school and class year.
function requireSetup(req, res, next) {
  const s = req.currentUser;
  if (!s.school_id || !s.class_year) return res.render('student/needs-setup', { title: 'Set up your profile' });
  next();
}

// Redirect targets come from hidden form fields, so only same-site
// student pages are accepted.
function backTo(req, fallback) {
  const target = req.body && req.body.return_to;
  if (typeof target === 'string' && /^\/student\/[A-Za-z0-9/_\-?=&%.#]*$/.test(target) && !target.startsWith('//')) {
    return target;
  }
  return fallback;
}

// The student's whole record, with the derived fields the pages share.
function loadRecord(student) {
  const today = todayISO();
  const competencies = getStudentCompetencies(student).map((c) => ({ ...c, u: urgency(c.due_date, today) }));
  const summary = summarize(competencies);
  const overdue = competencies.filter((c) => c.u.band === 'overdue' && c.status !== 'passed' && c.status !== 'tracking_only');
  const hasDeadlines = competencies.some((c) => c.due_date);
  return { today, competencies, summary, overdue, hasDeadlines, groups: groupByCategory(competencies) };
}

function getOwnedCompetency(student, competencyId) {
  return db
    .prepare('SELECT * FROM competencies WHERE id = ? AND school_id = ? AND class_year = ?')
    .get(competencyId, student.school_id, student.class_year);
}

function getOwnedItem(student, itemId) {
  return db
    .prepare(
      `SELECT ci.id AS item_id, ci.target_count, ci.competency_id,
              COALESCE(ip.current_count, 0) AS current_count
       FROM competency_items ci
       JOIN competencies c ON c.id = ci.competency_id
       LEFT JOIN item_progress ip ON ip.item_id = ci.id AND ip.student_id = ?
       WHERE ci.id = ? AND c.school_id = ? AND c.class_year = ?`
    )
    .get(student.id, itemId, student.school_id, student.class_year);
}

// ---------- Requirements ----------

const FILTERS = {
  all: ['Everything', () => true],
  actionable: ['Needs action from me', (c) => c.status === 'eligible' || c.status === 'needs_retest'],
  eligible: ['Eligible to attempt now', (c) => c.status === 'eligible'],
  blocked: ['Prerequisites unmet', (c) => c.status === 'not_started' || c.status === 'prereqs_in_progress'],
  retest: ['Failed, remediation', (c) => c.status === 'needs_retest'],
  passed: ['Completed', (c) => c.status === 'passed'],
  starred: ['Starred', (c) => !!c.starred],
};

const SORTS = {
  due: ['Due date, soonest first', (a, b) => a.u.days - b.u.days || a.sort_order - b.sort_order],
  priority: ['Starred first, then due date', (a, b) => b.starred - a.starred || a.u.days - b.u.days],
  status: [
    'Status',
    (a, b) => STATUS_DISPLAY[a.status].order - STATUS_DISPLAY[b.status].order || a.u.days - b.u.days,
  ],
  category: ['Discipline', (a, b) => a.category.localeCompare(b.category) || a.sort_order - b.sort_order],
  manual: [
    'Order in the manual',
    (a, b) => (a.source_page || 1e6) - (b.source_page || 1e6) || a.sort_order - b.sort_order || a.id - b.id,
  ],
};

router.get('/dashboard', requireSetup, (req, res) => {
  const student = req.currentUser;
  const record = loadRecord(student);
  const show = FILTERS[req.query.show] ? req.query.show : 'all';
  const sort = SORTS[req.query.sort] ? req.query.sort : 'due';
  const q = String(req.query.q || '').trim().slice(0, 100);

  let rows = record.competencies.filter(FILTERS[show][1]);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((c) => `${c.title} ${c.category}`.toLowerCase().includes(needle));
  }
  rows = rows.slice().sort(SORTS[sort][1]);

  const soon = todayISO(new Date(Date.now() + 7 * 864e5));
  const reminders = record.competencies
    .filter((c) => c.reminder_on && c.reminder_on <= soon && c.status !== 'passed')
    .sort((a, b) => a.reminder_on.localeCompare(b.reminder_on));

  res.render('student/requirements', {
    title: 'Requirements',
    ...record,
    rows,
    show,
    sort,
    q,
    filters: FILTERS,
    sorts: SORTS,
    reminders,
    returnTo: req.originalUrl,
    categoryCount: record.groups.length,
  });
});

router.get('/competencies/:id', requireSetup, (req, res) => {
  const student = req.currentUser;
  const record = loadRecord(student);
  const comp = record.competencies.find((c) => c.id === parseInt(req.params.id, 10));
  if (!comp) return res.status(404).render('errors/404');
  const documents = listDocuments(student.id).filter((d) => d.competency_id === comp.id);
  res.render('student/competency', {
    title: comp.title,
    comp,
    documents,
    formatSize,
    returnTo: `/student/competencies/${comp.id}`,
  });
});

router.post('/competencies/:id/star', verifyCsrfToken, requireSetup, (req, res) => {
  const student = req.currentUser;
  const comp = getOwnedCompetency(student, parseInt(req.params.id, 10));
  if (!comp) return res.status(404).render('errors/404');
  const current = getNotes(student.id, comp.id);
  saveNotes(student.id, comp.id, { starred: !current.starred });
  res.redirect(backTo(req, `/student/competencies/${comp.id}`));
});

router.post('/competencies/:id/notes', verifyCsrfToken, requireSetup, (req, res) => {
  const student = req.currentUser;
  const comp = getOwnedCompetency(student, parseInt(req.params.id, 10));
  if (!comp) return res.status(404).render('errors/404');
  saveNotes(student.id, comp.id, { note: String(req.body.note || '').slice(0, 4000) });
  req.flash('success', 'Note saved.');
  res.redirect(`/student/competencies/${comp.id}`);
});

router.post('/competencies/:id/reminder', verifyCsrfToken, requireSetup, (req, res) => {
  const student = req.currentUser;
  const comp = getOwnedCompetency(student, parseInt(req.params.id, 10));
  if (!comp) return res.status(404).render('errors/404');
  const clear = req.body.clear === '1';
  const date = isISODate(req.body.reminder_on) ? req.body.reminder_on : null;
  saveNotes(student.id, comp.id, { reminder_on: clear ? null : date });
  req.flash('success', clear || !date ? 'Reminder cleared.' : 'Reminder set.');
  res.redirect(`/student/competencies/${comp.id}`);
});

// ---------- Prerequisite items and procedure counts ----------

function handleItemUpdate(req, res, computeNext) {
  const student = req.currentUser;
  const item = getOwnedItem(student, parseInt(req.params.itemId, 10));
  if (!item) {
    return res.status(400).render('errors/403', { message: 'That item does not apply to your account.' });
  }
  setItemProgress(student.id, item, computeNext(item));
  res.redirect(backTo(req, '/student/competencies/' + item.competency_id));
}

router.post('/items/:itemId/increment', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => item.current_count + 1);
});

router.post('/items/:itemId/decrement', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => item.current_count - 1);
});

router.post('/items/:itemId/toggle', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => (item.current_count > 0 ? 0 : item.target_count));
});

router.post('/procedures/:competencyId', verifyCsrfToken, (req, res) => {
  const student = req.currentUser;
  const competencyId = parseInt(req.params.competencyId, 10);
  const competency = db
    .prepare(
      `SELECT id FROM competencies
       WHERE id = ? AND tracking = 'procedure' AND school_id = ? AND class_year = ?`
    )
    .get(competencyId, student.school_id, student.class_year);
  if (!competency) {
    return res.status(400).render('errors/403', { message: 'That requirement does not apply to your account.' });
  }
  setProcedureProgress(student.id, competency.id, parseInt(req.body.d3_count, 10), parseInt(req.body.d4_count, 10));
  res.redirect(backTo(req, '/student/competencies/' + competency.id));
});

// Every counted prerequisite, as one table. "Thresholds" are count items;
// check items stay on each competency's own page.
function countThresholds(competencies) {
  const rows = [];
  for (const c of competencies) {
    for (const item of c.items) {
      if (item.item_type !== 'count') continue;
      rows.push({ comp: c, item, left: Math.max(0, item.target_count - item.current_count) });
    }
  }
  return rows;
}

router.get('/procedures', requireSetup, (req, res) => {
  const record = loadRecord(req.currentUser);
  const thresholds = countThresholds(record.competencies);
  const procedureRows = record.competencies.filter((c) => c.tracking === 'procedure');
  const waiting = record.competencies.filter(
    (c) => c.status !== 'passed' && c.items.some((i) => i.item_type === 'count' && i.current_count < i.target_count)
  );
  res.render('student/procedures', {
    title: 'Procedure Record',
    thresholds: thresholds.sort((a, b) => (a.left === 0) - (b.left === 0) || b.left - a.left),
    met: thresholds.filter((t) => t.left === 0).length,
    shortBy: thresholds.reduce((n, t) => n + t.left, 0),
    procedureRows,
    procedureTotal: procedureRows.reduce((n, c) => n + c.d3_count + c.d4_count, 0),
    waiting,
    returnTo: '/student/procedures',
  });
});

// ---------- Progress summary and manual ----------

router.get('/progress', requireSetup, (req, res) => {
  const student = req.currentUser;
  const record = loadRecord(student);
  const thresholds = countThresholds(record.competencies).filter((t) => t.left > 0);
  res.render('student/progress', {
    title: 'Progress Summary',
    ...record,
    categories: record.groups.map((g) => ({ category: g.category, ...summarize(g.items) })),
    thresholds: thresholds.sort((a, b) => b.left - a.left),
    weeks: weeksToGraduation(student.class_year),
    graduation: graduationDate(student.class_year),
  });
});

router.get('/manual', requireSetup, (req, res) => {
  const record = loadRecord(req.currentUser);
  res.render('student/manual', { title: 'Competency Manual', groups: record.groups });
});

// ---------- Semester goals ----------

router.get('/goals', requireSetup, (req, res) => {
  const goals = listGoals(req.currentUser.id);
  const today = todayISO();
  res.render('student/goals', {
    title: 'Semester Goals',
    faculty: goals.filter((g) => g.set_by === 'faculty'),
    mine: goals.filter((g) => g.set_by === 'student'),
    today,
  });
});

router.post('/goals', verifyCsrfToken, requireSetup, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) {
    req.flash('error', 'Give the goal a title.');
    return res.redirect('/student/goals');
  }
  addGoal({
    studentId: req.currentUser.id,
    setBy: 'student',
    title,
    detail: String(req.body.detail || '').trim(),
    targetDate: isISODate(req.body.target_date) ? req.body.target_date : null,
  });
  req.flash('success', 'Goal added.');
  res.redirect('/student/goals');
});

function getOwnGoal(req) {
  return db
    .prepare("SELECT * FROM goals WHERE id = ? AND student_id = ? AND set_by = 'student'")
    .get(parseInt(req.params.id, 10), req.currentUser.id);
}

router.post('/goals/:id/toggle', verifyCsrfToken, (req, res) => {
  const goal = getOwnGoal(req);
  if (!goal) return res.status(403).render('errors/403', { message: 'Only goals you set yourself can be changed here.' });
  db.prepare('UPDATE goals SET completed_on = ? WHERE id = ?').run(goal.completed_on ? null : todayISO(), goal.id);
  res.redirect('/student/goals');
});

router.post('/goals/:id/delete', verifyCsrfToken, (req, res) => {
  const goal = getOwnGoal(req);
  if (!goal) return res.status(403).render('errors/403', { message: 'Only goals you set yourself can be removed.' });
  db.prepare('DELETE FROM goals WHERE id = ?').run(goal.id);
  req.flash('success', 'Goal removed.');
  res.redirect('/student/goals');
});

// ---------- Documents ----------

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES },
  fileFilter(req, file, cb) {
    if (documentExtension(file.originalname)) return cb(null, true);
    cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

router.get('/documents', requireSetup, (req, res) => {
  const student = req.currentUser;
  const competencies = getStudentCompetencies(student);
  res.render('student/documents', {
    title: 'Documents',
    documents: listDocuments(student.id),
    competencies,
    kinds: DOCUMENT_KINDS,
    formatSize,
    preselect: parseInt(req.query.competency_id, 10) || null,
  });
});

router.post('/documents', requireSetup, (req, res) => {
  documentUpload.single('file')(req, res, (err) => {
    // multer must parse the body before the CSRF token in it can be read.
    if (!req.body || req.body._csrf !== req.session.csrfToken) {
      return res.status(403).render('errors/403', { message: 'Invalid or missing form token. Please reload and try again.' });
    }
    if (err) {
      req.flash('error', err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is over 15 MB.'
        : 'That file type is not accepted. Upload a PDF, Word document, text file or image.');
      return res.redirect('/student/documents');
    }
    if (!req.file) {
      req.flash('error', 'Choose a file to upload.');
      return res.redirect('/student/documents');
    }
    const student = req.currentUser;
    const competencyId = parseInt(req.body.competency_id, 10);
    const comp = competencyId ? getOwnedCompetency(student, competencyId) : null;
    const kind = DOCUMENT_KINDS.includes(req.body.kind) ? req.body.kind : 'Other';
    saveDocument({ studentId: student.id, competencyId: comp ? comp.id : null, kind, file: req.file });
    req.flash('success', `Uploaded ${req.file.originalname}.`);
    res.redirect(comp && req.body.return_to_comp === '1' ? `/student/competencies/${comp.id}` : '/student/documents');
  });
});

function getOwnDocument(req) {
  return db
    .prepare('SELECT * FROM documents WHERE id = ? AND student_id = ?')
    .get(parseInt(req.params.id, 10), req.currentUser.id);
}

router.get('/documents/:id/download', (req, res) => {
  const doc = getOwnDocument(req);
  if (!doc) return res.status(404).render('errors/404');
  sendDocument(res, doc);
});

router.post('/documents/:id/delete', verifyCsrfToken, (req, res) => {
  const doc = getOwnDocument(req);
  if (!doc) return res.status(404).render('errors/404');
  deleteDocument(doc);
  req.flash('success', `Removed ${doc.original_name}.`);
  res.redirect('/student/documents');
});

module.exports = router;
