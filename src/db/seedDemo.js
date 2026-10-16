const db = require('./index');
const { hashPassword } = require('../utils/password');
const { DEMO_PASSWORD } = require('../utils/demo');

function schoolId(name) {
  const row = db.prepare('SELECT id FROM schools WHERE name = ?').get(name);
  return row ? row.id : null;
}

function upsertUser({ username, role, fullName, school, classYear }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return { id: existing.id, created: false };
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, full_name, school_id, class_year, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .run(username, hashPassword(DEMO_PASSWORD), role, fullName, school ? schoolId(school) : null, classYear || null);
  return { id: Number(lastInsertRowid), created: true };
}

// Some checked-off items, a few passed exams and a few in progress, so the
// student dashboard has something to show.
function seedItemProgress(studentId, school, classYear) {
  const competencies = db
    .prepare('SELECT id FROM competencies WHERE school_id = ? AND class_year = ? ORDER BY sort_order, id')
    .all(schoolId(school), classYear);
  const items = db.prepare('SELECT id, target_count FROM competency_items WHERE competency_id = ? ORDER BY sort_order, id');
  const setItem = db.prepare('INSERT OR IGNORE INTO item_progress (student_id, item_id, current_count) VALUES (?, ?, ?)');
  const setExam = db.prepare(
    "INSERT OR IGNORE INTO competency_progress (student_id, competency_id, exam_status) VALUES (?, ?, 'passed')"
  );

  competencies.slice(0, 18).forEach((c, i) => {
    const rows = items.all(c.id);
    if (i < 10) {
      rows.forEach((item) => setItem.run(studentId, item.id, item.target_count));
      if (i < 6) setExam.run(studentId, c.id);
    } else {
      rows.forEach((item, j) => {
        if (j % 2 === 0) setItem.run(studentId, item.id, Math.max(1, Math.floor(item.target_count / 2)));
      });
    }
  });
}

function seedProcedureProgress(studentId, school, classYear) {
  const competencies = db
    .prepare('SELECT id, d3_required FROM competencies WHERE school_id = ? AND class_year = ? ORDER BY sort_order, id')
    .all(schoolId(school), classYear);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO procedure_progress (student_id, competency_id, d3_count, d4_count) VALUES (?, ?, ?, 0)'
  );
  competencies.forEach((c, i) => {
    if (i % 3 === 2) return;
    const d3 = c.d3_required ? (i % 3 === 0 ? c.d3_required : Math.ceil(c.d3_required / 2)) : i % 4;
    insert.run(studentId, c.id, d3);
  });
}

function seedDemo() {
  const seed = db.transaction(() => {
    upsertUser({ username: 'demo-admin', role: 'admin', fullName: 'Demo Admin' });

    const detroit = 'University of Detroit Mercy School of Dentistry';
    const student = upsertUser({
      username: 'demo-student',
      role: 'student',
      fullName: 'Demo Student',
      school: detroit,
      classYear: 2028,
    });
    if (student.created) {
      seedItemProgress(student.id, detroit, 2028);
      db.prepare("INSERT INTO messages (student_id, sender, body) VALUES (?, 'admin', ?)").run(
        student.id,
        'Welcome! This is your inbox with the program admin. Send a question here and an admin can reply.'
      );
    }

    const nyu = 'New York University College of Dentistry';
    const nyuStudent = upsertUser({
      username: 'demo-nyu',
      role: 'student',
      fullName: 'Demo NYU Student',
      school: nyu,
      classYear: 2027,
    });
    if (nyuStudent.created) seedProcedureProgress(nyuStudent.id, nyu, 2027);
  });
  seed();
  console.log(`Demo mode: demo-admin, demo-student and demo-nyu are ready (password: ${DEMO_PASSWORD}).`);
}

module.exports = seedDemo;
