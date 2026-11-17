CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  -- Institution theme key (see src/utils/themes.js). NULL = app default.
  theme TEXT
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
  -- The user's own theme choice from the switcher; NULL = their school's.
  theme TEXT,
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
  -- Optional hard deadline (YYYY-MM-DD). Drives the overdue / weeks
  -- remaining tags; due_label stays as free text from the manual.
  due_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- 'items': cleared via prerequisite items + an exam outcome (Detroit Mercy
  -- style). 'procedure': a running count of patient procedures logged in D3
  -- and D4 against D3, D4 and/or combined D3+D4 minimums (NYU PPE style).
  tracking TEXT NOT NULL DEFAULT 'items' CHECK (tracking IN ('items', 'procedure')),
  d3_required INTEGER,
  d4_required INTEGER,
  combined_required INTEGER,
  -- Procedure rows sharing a group name (within a category) only count as
  -- complete once every row in the group is complete, e.g. NYU's Overdenture
  -- group.
  requirement_group TEXT,
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
  -- Who recorded the outcome and on what date (set when it's recorded).
  assessed_by TEXT,
  assessed_on TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, competency_id)
);

-- How many of a 'procedure' competency a student has done in each year.
CREATE TABLE IF NOT EXISTS procedure_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  d3_count INTEGER NOT NULL DEFAULT 0,
  d4_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, competency_id)
);

-- A single ongoing message thread per student with the admin team. sender
-- is who wrote it; read_at is set once the OTHER party has seen it (null =
-- unread by its recipient).
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('student', 'admin')),
  body TEXT NOT NULL,
  attachment_name TEXT,
  attachment_path TEXT,
  attachment_mime TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A student's own annotations on a competency: a star, a private note and
-- a reminder date. Nothing here affects status.
CREATE TABLE IF NOT EXISTS student_competency_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE,
  starred INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  reminder_on TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, competency_id)
);

-- Semester goals. set_by = 'faculty' goals are required: only an admin
-- (clinic lead) can edit or remove them. 'student' goals are the student's.
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_by TEXT NOT NULL CHECK (set_by IN ('faculty', 'student')),
  set_by_name TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  target_date TEXT,
  completed_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A student's own coursework (papers, goal sheets, self-assessments),
-- optionally attached to a competency. Never patient material.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competency_id INTEGER REFERENCES competencies(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id);
CREATE INDEX IF NOT EXISTS idx_competencies_lookup ON competencies(school_id, class_year);
CREATE INDEX IF NOT EXISTS idx_competency_items_competency ON competency_items(competency_id);
CREATE INDEX IF NOT EXISTS idx_item_progress_student ON item_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_competency_progress_student ON competency_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_procedure_progress_student ON procedure_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_student_notes_student ON student_competency_notes(student_id);
CREATE INDEX IF NOT EXISTS idx_goals_student ON goals(student_id);
CREATE INDEX IF NOT EXISTS idx_documents_student ON documents(student_id);
