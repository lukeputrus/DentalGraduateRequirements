const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.tmpdir(), `dgr-test-flow-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

require('../src/db/seed');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

async function loginAsAdmin() {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  await agent.post('/login').type('form').send({ username: 'luke', password: '1234', _csrf: extractCsrf(loginPage.text) });
  const changePw = await agent.get('/account/change-password');
  await agent
    .post('/account/change-password')
    .type('form')
    .send({ current_password: '1234', new_password: 'NewAdminPass123', confirm_password: 'NewAdminPass123', _csrf: extractCsrf(changePw.text) });
  return agent;
}

test('end-to-end: admin builds a competency, student clears it, admin marks it passed', async () => {
  const admin = await loginAsAdmin();
  const school = db.prepare('SELECT id FROM schools LIMIT 1').get();

  // Admin creates a competency with a checkbox item and a counter item.
  const picker = await admin.get('/admin/competencies');
  await admin
    .post('/admin/competencies')
    .type('form')
    .send({
      school_id: school.id,
      class_year: 2029,
      category: 'Oral Surgery',
      dental_year: 'DS3',
      title: 'Test Competency',
      description: 'desc',
      _csrf: extractCsrf(picker.text),
    });

  const competency = db.prepare('SELECT * FROM competencies WHERE title = ?').get('Test Competency');
  assert.ok(competency, 'competency was created');

  const compPage = await admin.get(`/admin/competencies?school_id=${school.id}&class_year=2029`);
  const csrf2 = extractCsrf(compPage.text);
  await admin
    .post(`/admin/competencies/${competency.id}/items`)
    .type('form')
    .send({ label: 'Attend orientation', item_type: 'check', target_count: 1, _csrf: csrf2 });
  await admin
    .post(`/admin/competencies/${competency.id}/items`)
    .type('form')
    .send({ label: 'Complete cases', item_type: 'count', target_count: 3, _csrf: csrf2 });

  const items = db.prepare('SELECT * FROM competency_items WHERE competency_id = ? ORDER BY id').all(competency.id);
  assert.equal(items.length, 2);
  const [checkItem, countItem] = items;

  // Admin creates a student in that school/class year.
  const newStudentPage = await admin.get('/admin/students/new');
  await admin
    .post('/admin/students')
    .type('form')
    .send({ full_name: 'Test Student', username: 'flowtest', school_id: school.id, class_year: 2029, _csrf: extractCsrf(newStudentPage.text) });
  const student = db.prepare("SELECT * FROM users WHERE username = 'flowtest'").get();
  assert.ok(student, 'student was created');
  assert.equal(student.must_change_password, 1);

  // Log in as the student via a temp password we set directly (bypasses reading the flash-only generated one).
  const tempHash = require('../src/utils/password').hashPassword('TempPass123');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(tempHash, student.id);

  const studentAgent = request.agent(app);
  const studentLoginPage = await studentAgent.get('/login');
  await studentAgent
    .post('/login')
    .type('form')
    .send({ username: 'flowtest', password: 'TempPass123', _csrf: extractCsrf(studentLoginPage.text) });
  const studentChangePw = await studentAgent.get('/account/change-password');
  await studentAgent
    .post('/account/change-password')
    .type('form')
    .send({ current_password: 'TempPass123', new_password: 'StudentPass123', confirm_password: 'StudentPass123', _csrf: extractCsrf(studentChangePw.text) });

  const dashboard = await studentAgent.get('/student/dashboard');
  const csrf3 = extractCsrf(dashboard.text);
  assert.match(dashboard.text, /Test Competency/);
  assert.match(dashboard.text, /status-not_started/);

  // Toggle the checkbox item and bring the counter item up to its target.
  await studentAgent.post(`/student/items/${checkItem.id}/toggle`).type('form').send({ _csrf: csrf3 });
  await studentAgent.post(`/student/items/${countItem.id}/increment`).type('form').send({ _csrf: csrf3 });
  await studentAgent.post(`/student/items/${countItem.id}/increment`).type('form').send({ _csrf: csrf3 });
  await studentAgent.post(`/student/items/${countItem.id}/increment`).type('form').send({ _csrf: csrf3 });

  const afterItems = await studentAgent.get('/student/dashboard');
  assert.match(afterItems.text, /status-eligible/);

  // A student cannot touch an item outside their own school/class year's competencies.
  const otherSchool = db.prepare('SELECT id FROM schools WHERE id != ?').get(school.id);
  db.prepare('INSERT INTO competencies (school_id, class_year, category, title) VALUES (?, ?, ?, ?)').run(otherSchool.id, 2029, 'X', 'Other');
  const otherCompetency = db.prepare("SELECT id FROM competencies WHERE title = 'Other'").get();
  db.prepare('INSERT INTO competency_items (competency_id, label, item_type, target_count) VALUES (?, ?, ?, ?)').run(
    otherCompetency.id,
    'Foreign item',
    'check',
    1
  );
  const foreignItem = db.prepare("SELECT id FROM competency_items WHERE label = 'Foreign item'").get();
  const forbidden = await studentAgent.post(`/student/items/${foreignItem.id}/toggle`).type('form').send({ _csrf: csrf3 });
  assert.equal(forbidden.status, 400);

  // Admin marks the exam passed; the student should see it reflected.
  const studentShowPage = await admin.get(`/admin/students/${student.id}`);
  await admin
    .post(`/admin/students/${student.id}/competencies/${competency.id}/exam`)
    .type('form')
    .send({ exam_status: 'passed', notes: 'Great job', _csrf: extractCsrf(studentShowPage.text) });

  const finalDashboard = await studentAgent.get('/student/dashboard');
  assert.match(finalDashboard.text, /status-passed/);
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});
