CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
  full_name TEXT NOT NULL,
  email TEXT,
  school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  class_year INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A competency is a single gradeable exam/skill a student must eventually
-- pass (e.g. "Local Anesthesia (IAN) Competency"). It belongs to one
-- school + graduating class year, same as the old flat requirements did.
CREATE TABLE IF NOT EXISTS competencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_year INTEGER NOT NULL,
  dental_year TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  title TEXT NOT NULL,
  description TEXT,
  source_page INTEGER,
  due_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The concrete prerequisite steps a student must clear before they're
-- eligible to sit a competency's exam. "check" is a one-time pass/fail
-- step (target_count is always 1); "count" is done a specific number of
-- times (e.g. "perform 3 supervised IAN injections").
CREATE TABLE IF NOT EXISTS competency_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('check', 'count')),
  target_count INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES competency_items(id) ON DELETE CASCADE,
  current_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, item_id)
);

-- The exam outcome for a competency is a separate, explicit fact (a
-- student doesn't become "passed" just by finishing prerequisite items —
-- someone has to record that they sat and passed the exam).
CREATE TABLE IF NOT EXISTS competency_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  exam_status TEXT NOT NULL DEFAULT 'not_attempted' CHECK (exam_status IN ('not_attempted', 'passed', 'needs_retest')),
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, competency_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  attachment_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id);
CREATE INDEX IF NOT EXISTS idx_competencies_lookup ON competencies(school_id, class_year);
CREATE INDEX IF NOT EXISTS idx_competency_items_competency ON competency_items(competency_id);
CREATE INDEX IF NOT EXISTS idx_item_progress_student ON item_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_competency_progress_student ON competency_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_student ON chat_messages(student_id, created_at);
