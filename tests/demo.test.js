const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `dgr-test-demo-${Date.now()}.sqlite`);
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';

require('../src/db/seed');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

async function login(username) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = extractCsrf(page.text);
  const res = await agent.post('/login').type('form').send({ username, password: 'demo1234', _csrf: csrf });
  assert.equal(res.status, 302);
  return agent;
}

test('demo mode seeds demo accounts instead of the temp luke admin', () => {
  const names = db.prepare('SELECT username FROM users ORDER BY username').all().map((u) => u.username);
  assert.deepEqual(names, ['demo-admin', 'demo-nyu', 'demo-student']);
});

test('login page lists the demo logins', async () => {
  const res = await request(app).get('/login');
  assert.match(res.text, /demo-student/);
  assert.match(res.text, /demo1234/);
});

test('demo accounts log straight in and show seeded progress', async () => {
  const student = await login('demo-student');
  const dash = await student.get('/student/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Passed/);

  const nyu = await login('demo-nyu');
  assert.equal((await nyu.get('/student/dashboard')).status, 200);

  const admin = await login('demo-admin');
  assert.equal((await admin.get('/admin/dashboard')).status, 200);
});

test("demo passwords can't be changed or reset, and demo students can't be deleted", async () => {
  const student = await login('demo-student');
  const page = await student.get('/account/change-password');
  const res = await student.post('/account/change-password').type('form').send({
    current_password: 'demo1234', new_password: 'hijacked123', confirm_password: 'hijacked123', _csrf: extractCsrf(page.text),
  });
  assert.equal(res.status, 400);

  const { id } = db.prepare("SELECT id FROM users WHERE username = 'demo-student'").get();
  const admin = await login('demo-admin');
  const csrf = extractCsrf((await admin.get(`/admin/students/${id}`)).text);
  await admin.post(`/admin/students/${id}/reset-password`).type('form').send({ password: 'hijacked123', _csrf: csrf });
  await admin.post(`/admin/students/${id}/delete`).type('form').send({ _csrf: csrf });

  await login('demo-student');
});
