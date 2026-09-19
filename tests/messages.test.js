const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.tmpdir(), `dgr-test-messages-${Date.now()}.sqlite`);
const uploadsDir = path.join(os.tmpdir(), `dgr-test-uploads-${Date.now()}`);
process.env.DATABASE_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

require('../src/db/seed');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { hashPassword } = require('../src/utils/password');

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

let admin;
let student;
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
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, school_id, class_year) VALUES (?, ?, 'student', 'Message Test Student', ?, 2030)`
  ).run('msgstudent', hashPassword('StudentPass123'), schoolId);
  student = db.prepare("SELECT * FROM users WHERE username = 'msgstudent'").get();
});

test('a student can send a message with an attachment, and it appears in the admin inbox unread', async () => {
  const studentAgent = request.agent(app);
  const loginPage = await studentAgent.get('/login');
  await studentAgent.post('/login').type('form').send({ username: 'msgstudent', password: 'StudentPass123', _csrf: extractCsrf(loginPage.text) });

  const dashboard = await studentAgent.get('/student/dashboard');
  const csrf = extractCsrf(dashboard.text);

  const sendRes = await studentAgent
    .post('/student/messages/send')
    .field('_csrf', csrf)
    .field('message', 'Can you fix my email on file?')
    .attach('attachment', Buffer.from('%PDF-1.4 fake'), { filename: 'proof.pdf', contentType: 'application/pdf' });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.body.ok, true);

  const inbox = await admin.get('/admin/messages');
  assert.match(inbox.text, /Message Test Student/);
  assert.match(inbox.text, /Can you fix my email on file\?/);
  assert.match(inbox.text, />1 new</);
});

test('admin opening a thread marks the student\'s message read, and a reply reaches the student', async () => {
  const thread = await admin.get(`/admin/messages/${student.id}`);
  assert.match(thread.text, /Can you fix my email on file\?/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages WHERE sender='student' AND read_at IS NULL").get().c, 0);

  const csrf = extractCsrf(thread.text);
  const replyRes = await admin
    .post(`/admin/messages/${student.id}/reply`)
    .field('_csrf', csrf)
    .field('message', 'Done, updated your email.');
  assert.equal(replyRes.status, 302);

  const studentAgent = request.agent(app);
  const loginPage = await studentAgent.get('/login');
  await studentAgent.post('/login').type('form').send({ username: 'msgstudent', password: 'StudentPass123', _csrf: extractCsrf(loginPage.text) });

  const unread = await studentAgent.get('/student/messages/unread-count');
  assert.equal(unread.body.count, 1);

  const history = await studentAgent.get('/student/messages/history');
  assert.equal(history.body.messages.length, 2);
  assert.equal(history.body.messages[1].body, 'Done, updated your email.');
  // history responses never leak the on-disk storage path
  assert.equal('attachment_path' in history.body.messages[0], false);

  const unreadAfter = await studentAgent.get('/student/messages/unread-count');
  assert.equal(unreadAfter.body.count, 0, 'viewing history should mark the admin reply read');
});

test('a student cannot download another student\'s attachment', async () => {
  const otherAgent = request.agent(app);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, school_id, class_year) VALUES (?, ?, 'student', 'Other Student', ?, 2030)`
  ).run('otherstudent2', hashPassword('OtherPass123'), schoolId);
  const loginPage = await otherAgent.get('/login');
  await otherAgent.post('/login').type('form').send({ username: 'otherstudent2', password: 'OtherPass123', _csrf: extractCsrf(loginPage.text) });

  const targetMessage = db.prepare("SELECT id FROM messages WHERE attachment_name = 'proof.pdf'").get();
  const res = await otherAgent.get(`/student/messages/attachment/${targetMessage.id}`);
  assert.equal(res.status, 404);
});

test('sending an empty message with no attachment is rejected', async () => {
  const studentAgent = request.agent(app);
  const loginPage = await studentAgent.get('/login');
  await studentAgent.post('/login').type('form').send({ username: 'msgstudent', password: 'StudentPass123', _csrf: extractCsrf(loginPage.text) });
  const dashboard = await studentAgent.get('/student/dashboard');

  const res = await studentAgent.post('/student/messages/send').field('_csrf', extractCsrf(dashboard.text)).field('message', '');
  assert.equal(res.status, 400);
});

test('an unsupported attachment type is rejected', async () => {
  const studentAgent = request.agent(app);
  const loginPage = await studentAgent.get('/login');
  await studentAgent.post('/login').type('form').send({ username: 'msgstudent', password: 'StudentPass123', _csrf: extractCsrf(loginPage.text) });
  const dashboard = await studentAgent.get('/student/dashboard');

  const res = await studentAgent
    .post('/student/messages/send')
    .field('_csrf', extractCsrf(dashboard.text))
    .field('message', 'here is a file')
    .attach('attachment', Buffer.from('not a real exe'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /PDF and image files/);
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});
