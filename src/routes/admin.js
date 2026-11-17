const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const { hashPassword, generateTempPassword } = require('../utils/password');
const {
  STATUS_LABELS,
  getStudentCompetencies,
  groupByCategory,
  summarize,
  setExamStatus,
  setProcedureProgress,
} = require('../utils/competencies');
const {
  ALLOWED_MIME_TYPES,
  getThread,
  getUnreadForAdmin,
  markReadForAdmin,
  sendAttachment,
  insertMessage,
} = require('../utils/messages');

const { isDemoAccount } = require('../utils/demo');
const { THEMES, isTheme } = require('../utils/themes');
const { listGoals, addGoal } = require('../utils/goals');
const { listDocuments, sendDocument, formatSize } = require('../utils/documents');
const { isISODate, todayISO, weeksToGraduation } = require('../utils/competencies');

const router = express.Router();

router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.unreadMessageCount = getUnreadForAdmin();
  next();
});

const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

function getSchools() {
  return db.prepare('SELECT * FROM schools ORDER BY name').all();
}

function studentWithSummary(student) {
  return { student, summary: summarize(getStudentCompetencies(student)) };
}

function clampTargetCount(itemType, raw) {
  if (itemType === 'check') return 1;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function optionalCount(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The tracking mode and D3/D4 requirement fields shared by the add and
// edit competency forms.
function procedureFields(body) {
  const tracking = body.tracking === 'procedure' ? 'procedure' : 'items';
  if (tracking !== 'procedure') {
    return { tracking, d3_required: null, d4_required: null, combined_required: null, requirement_group: null };
  }
  return {
    tracking,
    d3_required: optionalCount(body.d3_required),
    d4_required: optionalCount(body.d4_required),
    combined_required: optionalCount(body.combined_required),
    requirement_group: (body.requirement_group || '').trim() || null,
  };
}

// ---------- Dashboard ----------

// The cohort view: every student in a school + class year (or everyone),
// with the same derived counts the student sees on their own record.
router.get('/dashboard', (req, res) => {
  const schools = getSchools();
  const schoolId = parseInt(req.query.school_id, 10) || null;
  const classYear = parseInt(req.query.class_year, 10) || null;
  const today = todayISO();

  let query = "SELECT u.*, s.name AS school_name FROM users u LEFT JOIN schools s ON s.id = u.school_id WHERE u.role = 'student'";
  const params = [];
  if (schoolId) {
    query += ' AND u.school_id = ?';
    params.push(schoolId);
  }
  if (classYear) {
    query += ' AND u.class_year = ?';
    params.push(classYear);
  }
  query += ' ORDER BY u.full_name';

  const openGoals = db.prepare(
    "SELECT COUNT(*) AS c, SUM(CASE WHEN target_date < ? THEN 1 ELSE 0 END) AS late FROM goals WHERE student_id = ? AND set_by = 'faculty' AND completed_on IS NULL"
  );
  const unread = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE student_id = ? AND sender = 'student' AND read_at IS NULL");

  const students = db.prepare(query).all(...params).map((student) => {
    const competencies = getStudentCompetencies(student);
    const goals = openGoals.get(today, student.id);
    return {
      student,
      competencies,
      summary: summarize(competencies),
      overdue: competencies.filter((c) => c.due_date && c.due_date < today && c.status !== 'passed' && c.status !== 'tracking_only').length,
      goalsOpen: goals.c || 0,
      goalsLate: goals.late || 0,
      unread: unread.get(student.id).c,
    };
  });

  // Discipline grid only makes sense when everyone shares one requirement
  // set, i.e. one school and one class year.
  let grid = null;
  const sets = new Set(students.filter((r) => r.student.school_id && r.student.class_year).map((r) => `${r.student.school_id}:${r.student.class_year}`));
  if (students.length && sets.size === 1) {
    const categories = [...new Set(students[0].competencies.map((c) => c.category))];
    grid = {
      categories,
      rows: students.map((r) => ({
        student: r.student,
        cells: categories.map((cat) => {
          const s = summarize(r.competencies.filter((c) => c.category === cat));
          return { ...s, level: s.total === 0 ? -1 : Math.min(4, Math.floor((s.passed / s.total) * 4)) };
        }),
      })),
    };
  }

  const totals = {
    students: students.length,
    avgPercent: students.length ? Math.round(students.reduce((n, r) => n + r.summary.percent, 0) / students.length) : 0,
    eligible: students.reduce((n, r) => n + r.summary.eligible, 0),
    retest: students.filter((r) => r.summary.needs_retest > 0).length,
  };
  const classYears = db
    .prepare("SELECT DISTINCT class_year FROM users WHERE role = 'student' AND class_year IS NOT NULL ORDER BY class_year")
    .all()
    .map((r) => r.class_year);
  const schoolsWithStudents = db
    .prepare("SELECT DISTINCT s.* FROM schools s JOIN users u ON u.school_id = s.id AND u.role = 'student' ORDER BY s.name")
    .all();

  res.render('admin/dashboard', {
    title: 'Cohort',
    students,
    grid,
    totals,
    schools,
    schoolsWithStudents,
    classYears,
    schoolId,
    classYear,
    competencyCount: db.prepare('SELECT COUNT(*) AS c FROM competencies').get().c,
    schoolCount: schools.length,
  });
});

// ---------- Schools ----------

router.get('/schools', (req, res) => {
  const schools = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM users u WHERE u.school_id = s.id AND u.role = 'student') AS student_count,
        (SELECT COUNT(*) FROM competencies c WHERE c.school_id = s.id) AS competency_count
       FROM schools s ORDER BY s.name`
    )
    .all();
  res.render('admin/schools/index', { schools, error: null, themeOptions: THEMES });
});

router.post('/schools/:id/theme', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE schools SET theme = ? WHERE id = ?').run(isTheme(req.body.theme) ? req.body.theme : null, id);
  req.flash('success', 'Theme updated.');
  res.redirect('/admin/schools');
});

router.post('/schools', verifyCsrfToken, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    const schools = getSchools();
    return res.status(400).render('admin/schools/index', { schools, error: 'School name is required.', themeOptions: THEMES });
  }
  try {
    db.prepare('INSERT INTO schools (name) VALUES (?)').run(name);
    req.flash('success', `Added ${name}.`);
  } catch (e) {
    req.flash('error', 'That school already exists.');
  }
  res.redirect('/admin/schools');
});

router.post('/schools/:id/delete', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM users WHERE school_id = ?').get(id).c;
  if (inUse > 0) {
    req.flash('error', 'Cannot delete a school that still has students assigned to it.');
    return res.redirect('/admin/schools');
  }
  db.prepare('DELETE FROM schools WHERE id = ?').run(id);
  req.flash('success', 'School removed.');
  res.redirect('/admin/schools');
});

// ---------- Competencies ----------

router.get('/competencies', (req, res) => {
  const schools = getSchools();
  const schoolId = parseInt(req.query.school_id, 10) || null;
  const classYear = parseInt(req.query.class_year, 10) || null;

  const existingSets = db
    .prepare(
      `SELECT c.school_id, s.name AS school_name, c.class_year, COUNT(*) AS count
       FROM competencies c JOIN schools s ON s.id = c.school_id
       GROUP BY c.school_id, c.class_year
       ORDER BY s.name, c.class_year`
    )
    .all();

  let selectedSchool = null;
  let competencies = [];
  let otherYears = [];

  if (schoolId && classYear) {
    selectedSchool = schools.find((s) => s.id === schoolId) || null;
    if (selectedSchool) {
      competencies = db
        .prepare('SELECT * FROM competencies WHERE school_id = ? AND class_year = ? ORDER BY category, sort_order, id')
        .all(schoolId, classYear);
      const itemStmt = db.prepare('SELECT * FROM competency_items WHERE competency_id = ? ORDER BY sort_order, id');
      competencies = competencies.map((c) => ({ ...c, items: itemStmt.all(c.id) }));
      otherYears = existingSets.filter((set) => set.school_id === schoolId && set.class_year !== classYear);
    }
  }

  res.render('admin/competencies/index', {
    schools,
    existingSets,
    selectedSchool,
    classYear,
    competencies,
    otherYears,
    error: null,
  });
});

router.post('/competencies', verifyCsrfToken, (req, res) => {
  const schoolId = parseInt(req.body.school_id, 10);
  const classYear = parseInt(req.body.class_year, 10);
  const title = (req.body.title || '').trim();
  const category = (req.body.category || '').trim() || 'General';
  const dentalYear = (req.body.dental_year || '').trim() || null;
  const description = (req.body.description || '').trim();
  const dueLabel = (req.body.due_label || '').trim();
  const dueDate = isISODate(req.body.due_date) ? req.body.due_date : null;
  const sourcePage = parseInt(req.body.source_page, 10);

  if (!schoolId || !Number.isInteger(classYear) || classYear < 2000 || classYear > 2100 || !title) {
    req.flash('error', 'School, a valid graduation year, and a title are required.');
    return res.redirect(`/admin/competencies?school_id=${schoolId || ''}&class_year=${req.body.class_year || ''}`);
  }

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(schoolId, classYear).m;
  const proc = procedureFields(req.body);

  db.prepare(
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, due_label, due_date, source_page, sort_order,
       tracking, d3_required, d4_required, combined_required, requirement_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    schoolId,
    classYear,
    dentalYear,
    category,
    title,
    description || null,
    dueLabel || null,
    dueDate,
    Number.isInteger(sourcePage) ? sourcePage : null,
    maxOrder + 10,
    proc.tracking,
    proc.d3_required,
    proc.d4_required,
    proc.combined_required,
    proc.requirement_group
  );

  req.flash(
    'success',
    proc.tracking === 'procedure' ? 'Procedure requirement added.' : 'Competency added. Add its prerequisite items below.'
  );
  res.redirect(`/admin/competencies?school_id=${schoolId}&class_year=${classYear}`);
});

// NOTE: this must stay registered before POST /competencies/:id — Express
// matches routes in registration order, and :id would otherwise swallow
// "copy" as a literal id value.
router.post('/competencies/copy', verifyCsrfToken, (req, res) => {
  const schoolId = parseInt(req.body.school_id, 10);
  const fromYear = parseInt(req.body.from_year, 10);
  const toYear = parseInt(req.body.to_year, 10);

  if (!schoolId || !fromYear || !Number.isInteger(toYear) || toYear < 2000 || toYear > 2100) {
    req.flash('error', 'Please choose a source year and a valid destination year.');
    return res.redirect(`/admin/competencies?school_id=${schoolId || ''}&class_year=${toYear || ''}`);
  }

  const destinationCount = db
    .prepare('SELECT COUNT(*) AS c FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(schoolId, toYear).c;
  if (destinationCount > 0) {
    req.flash('error', `Class of ${toYear} already has competencies. Copy is only available for an empty year.`);
    return res.redirect(`/admin/competencies?school_id=${schoolId}&class_year=${toYear}`);
  }

  const sourceCompetencies = db
    .prepare('SELECT * FROM competencies WHERE school_id = ? AND class_year = ? ORDER BY sort_order, id')
    .all(schoolId, fromYear);
  const itemStmt = db.prepare('SELECT * FROM competency_items WHERE competency_id = ? ORDER BY sort_order, id');

  const insertCompetency = db.prepare(
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, due_label, source_page, sort_order,
       tracking, d3_required, d4_required, combined_required, requirement_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO competency_items (competency_id, label, item_type, target_count, sort_order) VALUES (?, ?, ?, ?, ?)`
  );

  const copyAll = db.transaction((rows) => {
    for (const row of rows) {
      const result = insertCompetency.run(
        schoolId,
        toYear,
        row.dental_year,
        row.category,
        row.title,
        row.description,
        row.due_label,
        row.source_page,
        row.sort_order,
        row.tracking,
        row.d3_required,
        row.d4_required,
        row.combined_required,
        row.requirement_group
      );
      const newCompetencyId = result.lastInsertRowid;
      for (const item of itemStmt.all(row.id)) {
        insertItem.run(newCompetencyId, item.label, item.item_type, item.target_count, item.sort_order);
      }
    }
  });
  copyAll(sourceCompetencies);

  req.flash('success', `Copied ${sourceCompetencies.length} competenc${sourceCompetencies.length === 1 ? 'y' : 'ies'} from ${fromYear} to ${toYear}.`);
  res.redirect(`/admin/competencies?school_id=${schoolId}&class_year=${toYear}`);
});

router.post('/competencies/:id', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM competencies WHERE id = ?').get(id);
  if (!existing) {
    req.flash('error', 'Competency not found.');
    return res.redirect('/admin/competencies');
  }

  const title = (req.body.title || '').trim();
  const category = (req.body.category || '').trim() || 'General';
  const dentalYear = (req.body.dental_year || '').trim() || null;
  const description = (req.body.description || '').trim();
  const dueLabel = (req.body.due_label || '').trim();
  const dueDate = isISODate(req.body.due_date) ? req.body.due_date : null;
  const sourcePage = parseInt(req.body.source_page, 10);
  const sortOrder = parseInt(req.body.sort_order, 10);

  if (!title) {
    req.flash('error', 'Title is required.');
    return res.redirect(`/admin/competencies?school_id=${existing.school_id}&class_year=${existing.class_year}`);
  }

  const proc = procedureFields(req.body);
  db.prepare(
    `UPDATE competencies SET title = ?, category = ?, dental_year = ?, description = ?, due_label = ?, due_date = ?, source_page = ?,
       sort_order = ?, tracking = ?, d3_required = ?, d4_required = ?, combined_required = ?, requirement_group = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title,
    category,
    dentalYear,
    description || null,
    dueLabel || null,
    dueDate,
    Number.isInteger(sourcePage) ? sourcePage : null,
    Number.isInteger(sortOrder) ? sortOrder : existing.sort_order,
    proc.tracking,
    proc.d3_required,
    proc.d4_required,
    proc.combined_required,
    proc.requirement_group,
    id
  );

  req.flash('success', 'Competency updated.');
  res.redirect(`/admin/competencies?school_id=${existing.school_id}&class_year=${existing.class_year}`);
});

router.post('/competencies/:id/delete', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM competencies WHERE id = ?').get(id);
  if (!existing) {
    req.flash('error', 'Competency not found.');
    return res.redirect('/admin/competencies');
  }
  db.prepare('DELETE FROM competencies WHERE id = ?').run(id);
  req.flash('success', 'Competency deleted.');
  res.redirect(`/admin/competencies?school_id=${existing.school_id}&class_year=${existing.class_year}`);
});

// ---------- Competency items ----------

router.post('/competencies/:id/items', verifyCsrfToken, (req, res) => {
  const competencyId = parseInt(req.params.id, 10);
  const competency = db.prepare('SELECT * FROM competencies WHERE id = ?').get(competencyId);
  if (!competency) {
    req.flash('error', 'Competency not found.');
    return res.redirect('/admin/competencies');
  }

  const label = (req.body.label || '').trim();
  const itemType = req.body.item_type === 'count' ? 'count' : 'check';
  const targetCount = clampTargetCount(itemType, req.body.target_count);

  if (!label) {
    req.flash('error', 'Item label is required.');
    return res.redirect(`/admin/competencies?school_id=${competency.school_id}&class_year=${competency.class_year}`);
  }

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM competency_items WHERE competency_id = ?')
    .get(competencyId).m;

  db.prepare(
    `INSERT INTO competency_items (competency_id, label, item_type, target_count, sort_order) VALUES (?, ?, ?, ?, ?)`
  ).run(competencyId, label, itemType, targetCount, maxOrder + 10);

  req.flash('success', 'Item added.');
  res.redirect(`/admin/competencies?school_id=${competency.school_id}&class_year=${competency.class_year}`);
});

router.post('/competency-items/:id', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.prepare('SELECT * FROM competency_items WHERE id = ?').get(id);
  if (!item) {
    req.flash('error', 'Item not found.');
    return res.redirect('/admin/competencies');
  }
  const competency = db.prepare('SELECT * FROM competencies WHERE id = ?').get(item.competency_id);

  const label = (req.body.label || '').trim();
  const itemType = req.body.item_type === 'count' ? 'count' : 'check';
  const targetCount = clampTargetCount(itemType, req.body.target_count);
  const sortOrder = parseInt(req.body.sort_order, 10);

  if (!label) {
    req.flash('error', 'Item label is required.');
    return res.redirect(`/admin/competencies?school_id=${competency.school_id}&class_year=${competency.class_year}`);
  }

  db.prepare(
    `UPDATE competency_items SET label = ?, item_type = ?, target_count = ?, sort_order = ? WHERE id = ?`
  ).run(label, itemType, targetCount, Number.isInteger(sortOrder) ? sortOrder : item.sort_order, id);

  req.flash('success', 'Item updated.');
  res.redirect(`/admin/competencies?school_id=${competency.school_id}&class_year=${competency.class_year}`);
});

router.post('/competency-items/:id/delete', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.prepare('SELECT * FROM competency_items WHERE id = ?').get(id);
  if (!item) {
    req.flash('error', 'Item not found.');
    return res.redirect('/admin/competencies');
  }
  const competency = db.prepare('SELECT * FROM competencies WHERE id = ?').get(item.competency_id);
  db.prepare('DELETE FROM competency_items WHERE id = ?').run(id);
  req.flash('success', 'Item deleted.');
  res.redirect(`/admin/competencies?school_id=${competency.school_id}&class_year=${competency.class_year}`);
});

// ---------- Students ----------

router.get('/students', (req, res) => {
  const schools = getSchools();
  const schoolId = parseInt(req.query.school_id, 10) || null;
  const classYear = parseInt(req.query.class_year, 10) || null;

  let query = "SELECT * FROM users WHERE role = 'student'";
  const params = [];
  if (schoolId) {
    query += ' AND school_id = ?';
    params.push(schoolId);
  }
  if (classYear) {
    query += ' AND class_year = ?';
    params.push(classYear);
  }
  query += ' ORDER BY full_name';

  const students = db.prepare(query).all(...params).map(studentWithSummary);

  res.render('admin/students/index', { students, schools, schoolId, classYear });
});

router.get('/students/new', (req, res) => {
  const schools = getSchools();
  res.render('admin/students/new', { schools, error: null, form: {} });
});

router.post('/students', verifyCsrfToken, (req, res) => {
  const schools = getSchools();
  const fullName = (req.body.full_name || '').trim();
  const username = (req.body.username || '').trim().toLowerCase();
  const email = (req.body.email || '').trim();
  const schoolId = parseInt(req.body.school_id, 10);
  const classYear = parseInt(req.body.class_year, 10);
  const customPassword = req.body.password || '';

  const fail = (error) =>
    res.status(400).render('admin/students/new', { schools, error, form: req.body });

  if (!fullName || !username) return fail('Full name and username are required.');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return fail('Username must be 3-32 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  if (!schoolId || !schools.some((s) => s.id === schoolId)) return fail('Please select a valid dental school.');
  if (!Number.isInteger(classYear) || classYear < 2000 || classYear > 2100) return fail('Please enter a valid graduation year.');
  if (customPassword && customPassword.length < 8) return fail('Temporary password must be at least 8 characters (or leave it blank to auto-generate one).');

  const existing = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(username);
  if (existing) return fail('That username is already taken.');

  const tempPassword = customPassword || generateTempPassword();
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, email, school_id, class_year, must_change_password)
     VALUES (?, ?, 'student', ?, ?, ?, ?, 1)`
  ).run(username, hashPassword(tempPassword), fullName, email || null, schoolId, classYear);

  req.flash('success', `Student account created for ${fullName}. Username: ${username} / Temporary password: ${tempPassword} (shown once — share it with the student now).`);
  res.redirect('/admin/students');
});

// The clinic lead's view of one student. `record` is the stored row when
// `student` carries unsaved form input, so progress still loads correctly.
function renderStudentRecord(res, student, error, record = student) {
  const competencies = getStudentCompetencies(record);
  res.render('admin/students/show', {
    title: student.full_name,
    student,
    schools: getSchools(),
    groups: groupByCategory(competencies),
    summary: summarize(competencies),
    competencies,
    goals: listGoals(record.id),
    documents: listDocuments(record.id),
    formatSize,
    weeks: weeksToGraduation(record.class_year),
    error,
    statusLabels: STATUS_LABELS,
  });
}

router.get('/students/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  if (!student) return res.status(404).render('errors/404');

  renderStudentRecord(res, student, null);
});

router.post('/students/:id', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  if (!student) return res.status(404).render('errors/404');

  const schools = getSchools();
  const fullName = (req.body.full_name || '').trim();
  const username = (req.body.username || '').trim().toLowerCase();
  const email = (req.body.email || '').trim();
  const schoolId = parseInt(req.body.school_id, 10);
  const classYear = parseInt(req.body.class_year, 10);

  const fail = (error) => renderStudentRecord(res.status(400), { ...student, ...req.body }, error, student);

  if (!fullName || !username) return fail('Full name and username are required.');
  if (isDemoAccount(student) && username !== student.username) return fail("A demo account's username can't be changed.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return fail('Username must be 3-32 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  if (!schoolId || !schools.some((s) => s.id === schoolId)) return fail('Please select a valid dental school.');
  if (!Number.isInteger(classYear) || classYear < 2000 || classYear > 2100) return fail('Please enter a valid graduation year.');

  const usernameTaken = db.prepare('SELECT id FROM users WHERE lower(username) = ? AND id != ?').get(username, id);
  if (usernameTaken) return fail('That username is already taken.');

  db.prepare(
    `UPDATE users SET full_name = ?, username = ?, email = ?, school_id = ?, class_year = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(fullName, username, email || null, schoolId, classYear, id);

  req.flash('success', 'Student account updated.');
  res.redirect(`/admin/students/${id}`);
});

router.post('/students/:id/reset-password', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  if (!student) return res.status(404).render('errors/404');

  if (isDemoAccount(student)) {
    req.flash('error', "Demo accounts' passwords can't be reset.");
    return res.redirect(`/admin/students/${id}`);
  }

  const customPassword = req.body.password || '';
  if (customPassword && customPassword.length < 8) {
    req.flash('error', 'Temporary password must be at least 8 characters (or leave it blank to auto-generate one).');
    return res.redirect(`/admin/students/${id}`);
  }

  const tempPassword = customPassword || generateTempPassword();
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(hashPassword(tempPassword), id);

  req.flash('success', `Password reset for ${student.full_name}. New temporary password: ${tempPassword} (shown once — share it with the student now).`);
  res.redirect(`/admin/students/${id}`);
});

router.post('/students/:id/delete', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isDemoAccount(db.prepare('SELECT username FROM users WHERE id = ?').get(id))) {
    req.flash('error', "Demo accounts can't be removed.");
    return res.redirect(`/admin/students/${id}`);
  }
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(id);
  req.flash('success', 'Student account removed.');
  res.redirect('/admin/students');
});

router.post('/students/:id/competencies/:competencyId/exam', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const competencyId = parseInt(req.params.competencyId, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  const competency = db.prepare('SELECT * FROM competencies WHERE id = ?').get(competencyId);
  if (!student || !competency || competency.school_id !== student.school_id || competency.class_year !== student.class_year) {
    req.flash('error', 'That competency does not apply to this student.');
    return res.redirect(`/admin/students/${id}`);
  }

  const examStatus = ['not_attempted', 'passed', 'needs_retest'].includes(req.body.exam_status)
    ? req.body.exam_status
    : 'not_attempted';
  const notes = (req.body.notes || '').trim();

  setExamStatus(id, competencyId, examStatus, notes, req.currentUser.full_name);
  req.flash('success', `Marked "${competency.title}" as ${examStatus.replace('_', ' ')}.`);
  res.redirect(`/admin/students/${id}#comp-${competencyId}`);
});

router.post('/students/:id/procedures/:competencyId', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const competencyId = parseInt(req.params.competencyId, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  const competency = db.prepare("SELECT * FROM competencies WHERE id = ? AND tracking = 'procedure'").get(competencyId);
  if (!student || !competency || competency.school_id !== student.school_id || competency.class_year !== student.class_year) {
    req.flash('error', 'That requirement does not apply to this student.');
    return res.redirect(`/admin/students/${id}`);
  }

  setProcedureProgress(id, competencyId, parseInt(req.body.d3_count, 10), parseInt(req.body.d4_count, 10));
  req.flash('success', `Updated counts for "${competency.title}".`);
  res.redirect(`/admin/students/${id}#comp-${competencyId}`);
});

// ---------- Required goals and student documents ----------

function getStudent(id) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
}

router.post('/students/:id/goals', verifyCsrfToken, (req, res) => {
  const student = getStudent(parseInt(req.params.id, 10));
  if (!student) return res.status(404).render('errors/404');
  const title = (req.body.title || '').trim();
  if (!title) {
    req.flash('error', 'Give the goal a title.');
    return res.redirect(`/admin/students/${student.id}#goals`);
  }
  addGoal({
    studentId: student.id,
    setBy: 'faculty',
    setByName: req.currentUser.full_name,
    title,
    detail: (req.body.detail || '').trim(),
    targetDate: isISODate(req.body.target_date) ? req.body.target_date : null,
  });
  req.flash('success', `Required goal set for ${student.full_name}.`);
  res.redirect(`/admin/students/${student.id}#goals`);
});

function getFacultyGoal(req) {
  return db
    .prepare("SELECT * FROM goals WHERE id = ? AND student_id = ? AND set_by = 'faculty'")
    .get(parseInt(req.params.goalId, 10), parseInt(req.params.id, 10));
}

router.post('/students/:id/goals/:goalId/toggle', verifyCsrfToken, (req, res) => {
  const goal = getFacultyGoal(req);
  if (!goal) return res.status(404).render('errors/404');
  db.prepare('UPDATE goals SET completed_on = ? WHERE id = ?').run(goal.completed_on ? null : todayISO(), goal.id);
  res.redirect(`/admin/students/${goal.student_id}#goals`);
});

router.post('/students/:id/goals/:goalId/delete', verifyCsrfToken, (req, res) => {
  const goal = getFacultyGoal(req);
  if (!goal) return res.status(404).render('errors/404');
  db.prepare('DELETE FROM goals WHERE id = ?').run(goal.id);
  req.flash('success', 'Goal removed.');
  res.redirect(`/admin/students/${goal.student_id}#goals`);
});

router.get('/documents/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).render('errors/404');
  sendDocument(res, doc);
});

// ---------- Messages ----------

router.get('/messages', (req, res) => {
  const threads = db
    .prepare(
      `SELECT u.id AS student_id, u.full_name, u.username,
        (SELECT body FROM messages m WHERE m.student_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_body,
        (SELECT sender FROM messages m WHERE m.student_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
        (SELECT created_at FROM messages m WHERE m.student_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
        (SELECT COUNT(*) FROM messages m WHERE m.student_id = u.id AND m.sender = 'student' AND m.read_at IS NULL) AS unread_count
       FROM users u
       WHERE u.role = 'student' AND EXISTS (SELECT 1 FROM messages m WHERE m.student_id = u.id)
       ORDER BY last_at DESC`
    )
    .all();
  res.render('admin/messages/index', { threads });
});

router.get('/messages/:studentId', (req, res) => {
  const studentId = parseInt(req.params.studentId, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(studentId);
  if (!student) return res.status(404).render('errors/404');

  const thread = getThread(studentId);
  markReadForAdmin(studentId);
  res.render('admin/messages/show', { student, thread });
});

router.post('/messages/:studentId/reply', (req, res) => {
  messageUpload.single('attachment')(req, res, (uploadErr) => {
    const studentId = parseInt(req.params.studentId, 10);
    const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(studentId);
    if (!student) return res.status(404).render('errors/404');

    if (uploadErr) {
      req.flash('error', uploadErr.message === 'UNSUPPORTED_FILE_TYPE'
        ? 'Only PDF and image files (PNG, JPEG, WEBP, GIF) are supported.'
        : 'That file is too large (15MB max) or could not be uploaded.');
      return res.redirect(`/admin/messages/${studentId}`);
    }
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
      return res.status(403).render('errors/403', { message: 'Your session expired. Please go back and try again.' });
    }

    const body = (req.body.message || '').trim();
    const file = req.file;
    if (!body && !file) {
      req.flash('error', 'Type a message or attach a file first.');
      return res.redirect(`/admin/messages/${studentId}`);
    }

    insertMessage({ studentId, sender: 'admin', body: body || '(sent an attachment)', file });
    req.flash('success', 'Reply sent.');
    res.redirect(`/admin/messages/${studentId}`);
  });
});

router.get('/messages/attachment/:id', (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!message) return res.status(404).end();
  sendAttachment(res, message);
});

module.exports = router;
