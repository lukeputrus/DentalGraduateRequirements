const express = require('express');
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
} = require('../utils/competencies');

const router = express.Router();

router.use(requireAdmin);

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

// ---------- Dashboard ----------

router.get('/dashboard', (req, res) => {
  const schoolCount = db.prepare('SELECT COUNT(*) AS c FROM schools').get().c;
  const studentCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'student'").get().c;
  const competencyCount = db.prepare('SELECT COUNT(*) AS c FROM competencies').get().c;
  const studentsBySchool = db
    .prepare(
      `SELECT s.name AS school_name, COUNT(u.id) AS student_count
       FROM schools s LEFT JOIN users u ON u.school_id = s.id AND u.role = 'student'
       GROUP BY s.id ORDER BY student_count DESC, s.name`
    )
    .all();

  res.render('admin/dashboard', { schoolCount, studentCount, competencyCount, studentsBySchool });
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
  res.render('admin/schools/index', { schools, error: null });
});

router.post('/schools', verifyCsrfToken, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    const schools = getSchools();
    return res.status(400).render('admin/schools/index', { schools, error: 'School name is required.' });
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
  const sourcePage = parseInt(req.body.source_page, 10);

  if (!schoolId || !Number.isInteger(classYear) || classYear < 2000 || classYear > 2100 || !title) {
    req.flash('error', 'School, a valid graduation year, and a title are required.');
    return res.redirect(`/admin/competencies?school_id=${schoolId || ''}&class_year=${req.body.class_year || ''}`);
  }

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(schoolId, classYear).m;

  db.prepare(
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, due_label, source_page, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    schoolId,
    classYear,
    dentalYear,
    category,
    title,
    description || null,
    dueLabel || null,
    Number.isInteger(sourcePage) ? sourcePage : null,
    maxOrder + 10
  );

  req.flash('success', 'Competency added. Add its prerequisite items below.');
  res.redirect(`/admin/competencies?school_id=${schoolId}&class_year=${classYear}`);
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
  const sourcePage = parseInt(req.body.source_page, 10);
  const sortOrder = parseInt(req.body.sort_order, 10);

  if (!title) {
    req.flash('error', 'Title is required.');
    return res.redirect(`/admin/competencies?school_id=${existing.school_id}&class_year=${existing.class_year}`);
  }

  db.prepare(
    `UPDATE competencies SET title = ?, category = ?, dental_year = ?, description = ?, due_label = ?, source_page = ?,
       sort_order = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title,
    category,
    dentalYear,
    description || null,
    dueLabel || null,
    Number.isInteger(sourcePage) ? sourcePage : null,
    Number.isInteger(sortOrder) ? sortOrder : existing.sort_order,
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
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, due_label, source_page, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        row.sort_order
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

  const fail = (error) =>
    res.status(400).render('admin/students/new', { schools, error, form: req.body });

  if (!fullName || !username) return fail('Full name and username are required.');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return fail('Username must be 3-32 characters: letters, numbers, dot, underscore, or hyphen.');
  }
  if (!schoolId || !schools.some((s) => s.id === schoolId)) return fail('Please select a valid dental school.');
  if (!Number.isInteger(classYear) || classYear < 2000 || classYear > 2100) return fail('Please enter a valid graduation year.');

  const existing = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(username);
  if (existing) return fail('That username is already taken.');

  const tempPassword = generateTempPassword();
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, email, school_id, class_year, must_change_password)
     VALUES (?, ?, 'student', ?, ?, ?, ?, 1)`
  ).run(username, hashPassword(tempPassword), fullName, email || null, schoolId, classYear);

  req.flash('success', `Student account created for ${fullName}. Username: ${username} / Temporary password: ${tempPassword} (shown once — share it with the student now).`);
  res.redirect('/admin/students');
});

router.get('/students/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(id);
  if (!student) return res.status(404).render('errors/404');

  const schools = getSchools();
  const competencies = getStudentCompetencies(student);
  const groups = groupByCategory(competencies);
  const summary = summarize(competencies);

  res.render('admin/students/show', { student, schools, groups, summary, error: null, statusLabels: STATUS_LABELS });
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

  const fail = (error) => {
    const competencies = getStudentCompetencies(student);
    return res.status(400).render('admin/students/show', {
      student: { ...student, ...req.body },
      schools,
      groups: groupByCategory(competencies),
      summary: summarize(competencies),
      error,
      statusLabels: STATUS_LABELS,
    });
  };

  if (!fullName || !username) return fail('Full name and username are required.');
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

  const tempPassword = generateTempPassword();
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(hashPassword(tempPassword), id);

  req.flash('success', `Password reset for ${student.full_name}. New temporary password: ${tempPassword} (shown once — share it with the student now).`);
  res.redirect(`/admin/students/${id}`);
});

router.post('/students/:id/delete', verifyCsrfToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
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

  setExamStatus(id, competencyId, examStatus, notes);
  req.flash('success', `Marked "${competency.title}" as ${examStatus.replace('_', ' ')}.`);
  res.redirect(`/admin/students/${id}#comp-${competencyId}`);
});

module.exports = router;
