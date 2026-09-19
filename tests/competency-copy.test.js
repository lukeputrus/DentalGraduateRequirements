const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dbPath = path.join(os.tmpdir(), `dgr-test-copy-${Date.now()}.sqlite`);
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

// Regression test: POST /competencies/copy was previously shadowed by the
// earlier POST /competencies/:id route (Express matched ":id" against the
// literal string "copy" first), so the real copy handler never ran.
test('copying a competency set to a new class year actually copies competencies and their items', async () => {
  const newCompPage = await admin.get('/admin/competencies');
  await admin
    .post('/admin/competencies')
    .type('form')
    .send({
      school_id: schoolId,
      class_year: 2040,
      category: 'Oral Surgery',
      title: 'Copy Source Competency',
      _csrf: extractCsrf(newCompPage.text),
    });
  const source = db.prepare("SELECT * FROM competencies WHERE title = 'Copy Source Competency'").get();
  assert.ok(source);

  const compPage = await admin.get(`/admin/competencies?school_id=${schoolId}&class_year=2040`);
  const csrf = extractCsrf(compPage.text);
  await admin.post(`/admin/competencies/${source.id}/items`).type('form').send({ label: 'Do a thing', item_type: 'check', target_count: 1, _csrf: csrf });
  await admin.post(`/admin/competencies/${source.id}/items`).type('form').send({ label: 'Do N things', item_type: 'count', target_count: 4, _csrf: csrf });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM competency_items WHERE competency_id = ?').get(source.id).c, 2);

  const copyRes = await admin
    .post('/admin/competencies/copy')
    .type('form')
    .send({ school_id: schoolId, from_year: 2040, to_year: 2041, _csrf: csrf });
  assert.equal(copyRes.status, 302);
  assert.equal(copyRes.headers.location, `/admin/competencies?school_id=${schoolId}&class_year=2041`);

  const copied = db.prepare('SELECT * FROM competencies WHERE school_id = ? AND class_year = 2041').all(schoolId);
  assert.equal(copied.length, 1, 'the competency should have been copied to the new class year');
  assert.equal(copied[0].title, 'Copy Source Competency');

  const copiedItems = db.prepare('SELECT * FROM competency_items WHERE competency_id = ?').all(copied[0].id);
  assert.equal(copiedItems.length, 2, 'both items should have been copied along with the competency');

  // The source year is untouched.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM competencies WHERE school_id = ? AND class_year = 2040').get(schoolId).c, 1);
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});
