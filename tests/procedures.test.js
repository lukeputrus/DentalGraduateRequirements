const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(os.tmpdir(), `dgr-test-procedures-${Date.now()}.sqlite`);
process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

// Simulate a database created before procedure tracking existed, so the
// app's startup migration has to add the new competency columns.
const legacy = new DatabaseSync(dbPath);
legacy.exec(`CREATE TABLE competencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, school_id INTEGER NOT NULL, class_year INTEGER NOT NULL,
  dental_year TEXT, category TEXT NOT NULL DEFAULT 'General', title TEXT NOT NULL, description TEXT,
  source_page INTEGER, due_label TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
legacy.close();

require('../src/db/seed');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { hashPassword } = require('../src/utils/password');
const {
  computeProcedureStatus,
  applyRequirementGroups,
  summarize,
  getStudentCompetencies,
} = require('../src/utils/competencies');

const req = (d3, d4, combined) => ({ d3_required: d3, d4_required: d4, combined_required: combined });

test('procedure status: complete only when D3, D4 and combined minimums are all met', () => {
  assert.equal(computeProcedureStatus({ ...req(12, 12, 24), d3_count: 12, d4_count: 12 }).status, 'passed');
  assert.equal(computeProcedureStatus({ ...req(null, null, 75), d3_count: 50, d4_count: 25 }).status_label, 'PPE complete');
  // Combined total is met but the D4 minimum is not.
  const d3Only = computeProcedureStatus({ ...req(6, 6, 12), d3_count: 10, d4_count: 3 });
  assert.equal(d3Only.status, 'prereqs_in_progress');
  assert.equal(d3Only.status_label, 'D3 PPE complete');
  assert.equal(computeProcedureStatus({ ...req(null, null, 40), d3_count: 5, d4_count: 0 }).status_label, 'In progress');
  assert.equal(computeProcedureStatus({ ...req(3, 3, null), d3_count: 0, d4_count: 0 }).status, 'not_started');
  // A D4 minimum of 0 is already met.
  assert.equal(computeProcedureStatus({ ...req(1, 0, null), d3_count: 1, d4_count: 0 }).status, 'passed');
});

test('procedure status: rows with no requirement are tracking only and excluded from totals', () => {
  const tracked = { ...computeProcedureStatus({ ...req(null, null, null), d3_count: 4, d4_count: 2 }) };
  assert.equal(tracked.status, 'tracking_only');
  const s = summarize([tracked, { status: 'passed' }]);
  assert.equal(s.total, 1);
  assert.equal(s.percent, 100);
});

test('requirement groups: a met row is held back until the whole group is met', () => {
  const rows = [
    { tracking: 'procedure', category: 'Removable', requirement_group: 'Overdenture', ...req(null, null, 10), d3_count: 10, d4_count: 0 },
    { tracking: 'procedure', category: 'Removable', requirement_group: 'Overdenture', ...req(null, 10, 10), d3_count: 0, d4_count: 4 },
  ].map((r) => ({ ...r, ...computeProcedureStatus(r) }));
  applyRequirementGroups(rows);
  assert.equal(rows[0].status, 'prereqs_in_progress');
  assert.equal(rows[0].status_label, 'Met; group incomplete');
  assert.equal(rows[0].group_complete, false);

  rows[1].d4_count = 10;
  Object.assign(rows[1], computeProcedureStatus(rows[1]));
  rows[0].status = 'passed';
  applyRequirementGroups(rows);
  assert.ok(rows.every((r) => r.status === 'passed' && r.group_complete));
});

test('NYU is seeded with its PPE requirements, and an old database is migrated', () => {
  const school = db.prepare("SELECT id FROM schools WHERE name = 'New York University College of Dentistry'").get();
  const rows = db.prepare('SELECT * FROM competencies WHERE school_id = ? AND class_year = 2027').all(school.id);
  assert.equal(rows.length, 29);
  assert.ok(rows.every((r) => r.tracking === 'procedure'));
  const crowns = rows.find((r) => r.title === 'Fixed Crowns');
  assert.deepEqual([crowns.d3_required, crowns.d4_required, crowns.combined_required], [null, null, 75]);
  assert.equal(rows.filter((r) => r.requirement_group === 'Overdenture').length, 3);
});

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

test('end-to-end: an NYU student logs D3/D4 counts and sees PPE status', async () => {
  const school = db.prepare("SELECT id FROM schools WHERE name = 'New York University College of Dentistry'").get();
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, school_id, class_year)
     VALUES ('nyustudent', ?, 'student', 'NYU Student', ?, 2027)`
  ).run(hashPassword('StudentPass123'), school.id);
  const student = db.prepare("SELECT * FROM users WHERE username = 'nyustudent'").get();
  const srp = db.prepare("SELECT id FROM competencies WHERE school_id = ? AND title = 'Perio SRP'").get(school.id);

  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  await agent.post('/login').type('form').send({ username: 'nyustudent', password: 'StudentPass123', _csrf: extractCsrf(loginPage.text) });

  const dashboard = await agent.get('/student/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Fixed Crowns/);
  const csrf = extractCsrf(dashboard.text);

  await agent.post(`/student/procedures/${srp.id}`).type('form').send({ d3_count: 12, d4_count: 2, _csrf: csrf });
  let comp = getStudentCompetencies(student).find((c) => c.id === srp.id);
  assert.equal(comp.status_label, 'D3 PPE complete');

  await agent.post(`/student/procedures/${srp.id}`).type('form').send({ d3_count: 12, d4_count: 12, _csrf: csrf });
  comp = getStudentCompetencies(student).find((c) => c.id === srp.id);
  assert.equal(comp.status, 'passed');

  // Negative or junk input is stored as 0.
  await agent.post(`/student/procedures/${srp.id}`).type('form').send({ d3_count: -5, d4_count: 'abc', _csrf: csrf });
  comp = getStudentCompetencies(student).find((c) => c.id === srp.id);
  assert.deepEqual([comp.d3_count, comp.d4_count], [0, 0]);

  // A requirement from another school is refused.
  const other = db.prepare('SELECT id FROM competencies WHERE school_id != ? LIMIT 1').get(school.id);
  const forbidden = await agent.post(`/student/procedures/${other.id}`).type('form').send({ d3_count: 1, d4_count: 1, _csrf: csrf });
  assert.equal(forbidden.status, 400);
});
