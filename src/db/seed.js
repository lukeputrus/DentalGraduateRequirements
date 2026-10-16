const db = require('./index');
const dentalSchools = require('../data/dentalSchools');
const { hashPassword } = require('../utils/password');
const seedCompetencySets = require('./seedCompetencySets');
const seedDemo = require('./seedDemo');
const { isDemoMode } = require('../utils/demo');

function seedSchools() {
  const insert = db.prepare('INSERT OR IGNORE INTO schools (name) VALUES (?)');
  const insertMany = db.transaction((names) => {
    for (const name of names) insert.run(name);
  });
  insertMany(dentalSchools);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM schools').get();
  console.log(`Schools in database: ${count}`);
}

function seedTempAdmin() {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) {
    console.log('An admin account already exists; skipping temp admin creation.');
    return;
  }
  db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, email, must_change_password)
     VALUES (?, ?, 'admin', ?, ?, 1)`
  ).run('luke', hashPassword('1234'), 'Luke', null);
  console.log('Created temporary admin account -> username: luke / password: 1234 (must change on first login).');
}

seedSchools();
seedCompetencySets();
// The demo admin counts as an admin, so the temp luke/1234 account (whose
// password is in the README) is never created on a public demo.
if (isDemoMode()) seedDemo();
seedTempAdmin();
console.log('Seed complete.');
