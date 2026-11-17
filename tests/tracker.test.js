const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `dgr-test-tracker-${Date.now()}.sqlite`);
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dgr-test-uploads-'));
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';

require('../src/db/seed');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const { urgency } = require('../src/utils/competencies');

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

async function login(username) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ username, password: 'demo1234', _csrf: extractCsrf(page.text) });
  return agent;
}

const studentId = () => db.prepare("SELECT id FROM users WHERE username = 'demo-student'").get().id;
const firstCompetency = () =>
  db
    .prepare(
      `SELECT c.id FROM competencies c JOIN users u ON u.school_id = c.school_id AND u.class_year = c.class_year
       WHERE u.username = 'demo-student' ORDER BY c.sort_order, c.id LIMIT 1`
    )
    .get().id;

test('every student page renders', async () => {
  const s = await login('demo-student');
  for (const page of ['/student/dashboard', '/student/procedures', '/student/goals', '/student/documents', '/student/progress', '/student/manual', `/student/competencies/${firstCompetency()}`]) {
    const res = await s.get(page);
    assert.equal(res.status, 200, page);
  }
  const nyu = await login('demo-nyu');
  assert.equal((await nyu.get('/student/procedures')).status, 200);
});

test('requirements can be filtered and sorted on the server', async () => {
  const s = await login('demo-student');
  const res = await s.get('/student/dashboard?show=passed&sort=status');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /data-status="eligible"/);
  assert.match(res.text, /data-status="passed"/);
});

test('a student can star a competency, write a note and set a reminder', async () => {
  const s = await login('demo-student');
  const id = firstCompetency();
  const page = await s.get(`/student/competencies/${id}`);
  const csrf = extractCsrf(page.text);
  await s.post(`/student/competencies/${id}/star`).type('form').send({ _csrf: csrf, return_to: '/student/dashboard?show=starred' }).expect(302).expect('Location', '/student/dashboard?show=starred');
  await s.post(`/student/competencies/${id}/notes`).type('form').send({ _csrf: csrf, note: 'Bring the loupes' }).expect(302);
  await s.post(`/student/competencies/${id}/reminder`).type('form').send({ _csrf: csrf, reminder_on: '2030-01-02' }).expect(302);
  const row = db.prepare('SELECT * FROM student_competency_notes WHERE student_id = ? AND competency_id = ?').get(studentId(), id);
  assert.equal(row.starred, 1);
  assert.equal(row.note, 'Bring the loupes');
  assert.equal(row.reminder_on, '2030-01-02');
});

test('redirects after an update never leave the student pages', async () => {
  const s = await login('demo-student');
  const id = firstCompetency();
  const csrf = extractCsrf((await s.get(`/student/competencies/${id}`)).text);
  const res = await s.post(`/student/competencies/${id}/star`).type('form').send({ _csrf: csrf, return_to: '//evil.example/x' });
  assert.equal(res.headers.location, `/student/competencies/${id}`);
});

test('students manage their own goals but cannot touch required ones', async () => {
  const s = await login('demo-student');
  const csrf = extractCsrf((await s.get('/student/goals')).text);
  await s.post('/student/goals').type('form').send({ _csrf: csrf, title: 'Finish endo prereqs', target_date: '2030-02-01' }).expect(302);
  const mine = db.prepare("SELECT * FROM goals WHERE student_id = ? AND title = 'Finish endo prereqs'").get(studentId());
  assert.equal(mine.set_by, 'student');
  await s.post(`/student/goals/${mine.id}/toggle`).type('form').send({ _csrf: csrf }).expect(302);
  assert.ok(db.prepare('SELECT completed_on FROM goals WHERE id = ?').get(mine.id).completed_on);

  const required = db.prepare("SELECT * FROM goals WHERE student_id = ? AND set_by = 'faculty'").get(studentId());
  await s.post(`/student/goals/${required.id}/delete`).type('form').send({ _csrf: csrf }).expect(403);
  assert.ok(db.prepare('SELECT id FROM goals WHERE id = ?').get(required.id));
});

test('the clinic lead sets a required goal and records who assessed a competency', async () => {
  const admin = await login('demo-admin');
  const sid = studentId();
  const page = await admin.get(`/admin/students/${sid}`);
  assert.equal(page.status, 200);
  const csrf = extractCsrf(page.text);
  await admin.post(`/admin/students/${sid}/goals`).type('form').send({ _csrf: csrf, title: 'Reach 65 surfaces', target_date: '2030-03-01' }).expect(302);
  const goal = db.prepare("SELECT * FROM goals WHERE student_id = ? AND title = 'Reach 65 surfaces'").get(sid);
  assert.equal(goal.set_by, 'faculty');
  assert.equal(goal.set_by_name, 'Demo Admin');

  const id = firstCompetency();
  await admin.post(`/admin/students/${sid}/competencies/${id}/exam`).type('form').send({ _csrf: csrf, exam_status: 'passed', notes: '' }).expect(302);
  const cp = db.prepare('SELECT * FROM competency_progress WHERE student_id = ? AND competency_id = ?').get(sid, id);
  assert.equal(cp.assessed_by, 'Demo Admin');
  assert.match(cp.assessed_on, /^\d{4}-\d{2}-\d{2}$/);

  const s = await login('demo-student');
  const goals = await s.get('/student/goals');
  assert.match(goals.text, /Reach 65 surfaces/);
});

test('documents upload, download and stay private to their owner', async () => {
  const s = await login('demo-student');
  const csrf = extractCsrf((await s.get('/student/documents')).text);
  await s
    .post('/student/documents')
    .field('_csrf', csrf)
    .field('kind', 'Self-assessment')
    .field('competency_id', String(firstCompetency()))
    .attach('file', Buffer.from('my reflection'), 'reflection.txt')
    .expect(302);
  const doc = db.prepare("SELECT * FROM documents WHERE original_name = 'reflection.txt'").get();
  assert.ok(doc);
  assert.equal(doc.competency_id, firstCompetency());
  const dl = await s.get(`/student/documents/${doc.id}/download`).expect(200);
  assert.match(dl.headers['content-disposition'], /attachment/);

  const other = await login('demo-nyu');
  await other.get(`/student/documents/${doc.id}/download`).expect(404);

  const admin = await login('demo-admin');
  await admin.get(`/admin/documents/${doc.id}/download`).expect(200);

  const bad = await s
    .post('/student/documents')
    .field('_csrf', csrf)
    .field('kind', 'Other')
    .attach('file', Buffer.from('<script>'), 'page.html');
  assert.equal(bad.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM documents WHERE original_name = 'page.html'").get().c, 0);
});

test('the theme switcher stores a choice and falls back to the school theme', async () => {
  const s = await login('demo-nyu');
  let page = await s.get('/student/dashboard');
  assert.match(page.text, /data-institution="violet"/);
  const csrf = extractCsrf(page.text);
  await s.post('/account/theme').type('form').send({ _csrf: csrf, theme: 'mercy', return_to: '/student/goals' }).expect('Location', '/student/goals');
  page = await s.get('/student/dashboard');
  assert.match(page.text, /data-institution="mercy"/);
  await s.post('/account/theme').type('form').send({ _csrf: csrf, theme: '' });
  page = await s.get('/student/dashboard');
  assert.match(page.text, /data-institution="violet"/);
});

test('the demo role switcher moves between demo accounts only', async () => {
  const s = await login('demo-student');
  const csrf = extractCsrf((await s.get('/student/dashboard')).text);
  await s.post('/demo/view-as').type('form').send({ _csrf: csrf, username: 'demo-admin' }).expect(302);
  const cohort = await s.get('/admin/dashboard');
  assert.equal(cohort.status, 200);
  assert.match(cohort.text, /Cohort/);
});

test('cohort view shows the discipline grid for a single school and class', async () => {
  const admin = await login('demo-admin');
  const school = db.prepare("SELECT school_id, class_year FROM users WHERE username = 'demo-student'").get();
  const res = await admin.get(`/admin/dashboard?school_id=${school.school_id}&class_year=${school.class_year}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="cohort"/);
});

test('deadline bands', () => {
  assert.equal(urgency(null).band, 'none');
  assert.equal(urgency('2026-01-01', '2026-01-10').band, 'overdue');
  assert.equal(urgency('2026-01-20', '2026-01-10').band, 'now');
  assert.equal(urgency('2026-03-20', '2026-01-10').band, 'soon');
  assert.equal(urgency('2026-12-20', '2026-01-10').band, 'later');
});
