const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.tmpdir(), `dgr-test-auth-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

require('../src/db/seed');
const request = require('supertest');
const app = require('../src/app');

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

test('anonymous access to a protected page redirects to /login', async () => {
  const res = await request(app).get('/student/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('login rejects an unknown user and a wrong password, accepts the right one', async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const csrf = extractCsrf(loginPage.text);

  const unknownUser = await agent.post('/login').type('form').send({ username: 'nobody', password: 'x', _csrf: csrf });
  assert.equal(unknownUser.status, 401);

  const wrongPassword = await agent.post('/login').type('form').send({ username: 'luke', password: 'wrong', _csrf: csrf });
  assert.equal(wrongPassword.status, 401);

  const success = await agent.post('/login').type('form').send({ username: 'luke', password: '1234', _csrf: csrf });
  assert.equal(success.status, 302);
  assert.equal(success.headers.location, '/');
});

test('a POST without the CSRF token is rejected with 403', async () => {
  const agent = request.agent(app);
  await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ username: 'luke', password: '1234' });
  assert.equal(res.status, 403);
});

test('the seeded temp admin is forced to change their password before reaching the dashboard', async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const csrf = extractCsrf(loginPage.text);
  await agent.post('/login').type('form').send({ username: 'luke', password: '1234', _csrf: csrf });

  // enforcePasswordChange intercepts every route (including the role-based
  // redirect at "/") until the password is changed.
  const root = await agent.get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/account/change-password');

  const dashboard = await agent.get('/admin/dashboard');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.location, '/account/change-password');
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});
