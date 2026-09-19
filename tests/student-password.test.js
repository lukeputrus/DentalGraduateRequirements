const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.tmpdir(), `dgr-test-pw-${Date.now()}.sqlite`);
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

let admin;
let schoolId;

test.before(async () => {
  admin = request.agent(app);
  const loginPage = await admin.get('/login');
  await admin.post('/login').type('form').send({ username: 'luke', password: '1234', _csrf: extractCsrf(loginPage.text) });
  const changePw = await admin.get('/account/change-password');
  await admin
    .post('/account/change-password')
    .type('form')
    .send({ current_password: '1234', new_password: 'NewAdminPass123', confirm_password: 'NewAdminPass123', _csrf: extractCsrf(changePw.text) });
  schoolId = db.prepare('SELECT id FROM schools LIMIT 1').get().id;
});

test('admin can set a chosen temporary password when creating a student, and the student can log in with it', async () => {
  const newPage = await admin.get('/admin/students/new');
  const created = await admin
    .post('/admin/students')
    .type('form')
    .send({
      full_name: 'Chosen Password Student',
      username: 'chosenpw',
      school_id: schoolId,
      class_year: 2031,
      password: 'MyChosenPass1',
      _csrf: extractCsrf(newPage.text),
    });
  assert.equal(created.status, 302);

  const studentLogin = request.agent(app);
  const loginPage = await studentLogin.get('/login');
  const loginRes = await studentLogin
    .post('/login')
    .type('form')
    .send({ username: 'chosenpw', password: 'MyChosenPass1', _csrf: extractCsrf(loginPage.text) });
  assert.equal(loginRes.status, 302, 'student should be able to log in with the admin-chosen password');
});

test('a temporary password shorter than 8 characters is rejected on create', async () => {
  const newPage = await admin.get('/admin/students/new');
  const res = await admin
    .post('/admin/students')
    .type('form')
    .send({
      full_name: 'Too Short',
      username: 'tooshort',
      school_id: schoolId,
      class_year: 2031,
      password: 'short',
      _csrf: extractCsrf(newPage.text),
    });
  assert.equal(res.status, 400);
  assert.match(res.text, /at least 8 characters/);
  assert.equal(db.prepare("SELECT id FROM users WHERE username = 'tooshort'").get(), undefined);
});

test('admin can set a chosen password when resetting, and it replaces the old one', async () => {
  const newPage = await admin.get('/admin/students/new');
  await admin
    .post('/admin/students')
    .type('form')
    .send({ full_name: 'Reset Me', username: 'resetme', school_id: schoolId, class_year: 2031, _csrf: extractCsrf(newPage.text) });
  const student = db.prepare("SELECT * FROM users WHERE username = 'resetme'").get();
  assert.ok(student, 'student should have been created with an auto-generated password');

  const showPage = await admin.get(`/admin/students/${student.id}`);
  await admin
    .post(`/admin/students/${student.id}/reset-password`)
    .type('form')
    .send({ password: 'BrandNewChosen1', _csrf: extractCsrf(showPage.text) });

  const studentLogin = request.agent(app);
  const loginPage = await studentLogin.get('/login');
  const loginRes = await studentLogin
    .post('/login')
    .type('form')
    .send({ username: 'resetme', password: 'BrandNewChosen1', _csrf: extractCsrf(loginPage.text) });
  assert.equal(loginRes.status, 302);
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});
