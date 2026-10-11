const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'app.sqlite');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS won't add columns to a database created by an
// older version of the app, so add any that are missing.
const COMPETENCY_COLUMNS = {
  tracking: "TEXT NOT NULL DEFAULT 'items' CHECK (tracking IN ('items', 'procedure'))",
  d3_required: 'INTEGER',
  d4_required: 'INTEGER',
  combined_required: 'INTEGER',
  requirement_group: 'TEXT',
};
const existingColumns = new Set(db.prepare('PRAGMA table_info(competencies)').all().map((c) => c.name));
for (const [name, definition] of Object.entries(COMPETENCY_COLUMNS)) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE competencies ADD COLUMN ${name} ${definition}`);
}

// better-sqlite3-style helper: wraps fn in BEGIN/COMMIT (ROLLBACK on
// throw), matching the interface the rest of the codebase already uses.
db.transaction = function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

module.exports = db;
