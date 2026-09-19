const db = require('../db');

const STATUSES = ['not_started', 'prereqs_in_progress', 'eligible', 'passed', 'needs_retest'];

const STATUS_LABELS = {
  not_started: 'Not started',
  prereqs_in_progress: 'Prereqs in progress',
  eligible: 'Eligible / ready',
  passed: 'Passed',
  needs_retest: 'Needs retest',
};

function computeStatus(items, examStatus) {
  if (examStatus === 'passed') return 'passed';
  if (examStatus === 'needs_retest') return 'needs_retest';
  if (items.length === 0) return 'eligible';
  const done = items.filter((i) => i.current_count >= i.target_count).length;
  if (done === items.length) return 'eligible';
  if (done > 0) return 'prereqs_in_progress';
  return 'not_started';
}

// Returns every competency for a student's school + class year, each with
// its items (left-joined with that student's own item_progress) and a
// computed overall status.
function getStudentCompetencies(student) {
  if (!student.school_id || !student.class_year) return [];

  const competencies = db
    .prepare(
      `SELECT c.*, COALESCE(cp.exam_status, 'not_attempted') AS exam_status, cp.notes AS exam_notes
       FROM competencies c
       LEFT JOIN competency_progress cp ON cp.competency_id = c.id AND cp.student_id = ?
       WHERE c.school_id = ? AND c.class_year = ?
       ORDER BY c.category, c.sort_order, c.id`
    )
    .all(student.id, student.school_id, student.class_year);

  const itemStmt = db.prepare(
    `SELECT ci.id AS item_id, ci.label, ci.item_type, ci.target_count,
            COALESCE(ip.current_count, 0) AS current_count
     FROM competency_items ci
     LEFT JOIN item_progress ip ON ip.item_id = ci.id AND ip.student_id = ?
     WHERE ci.competency_id = ?
     ORDER BY ci.sort_order, ci.id`
  );

  return competencies.map((c) => {
    const items = itemStmt.all(student.id, c.id);
    return { ...c, items, status: computeStatus(items, c.exam_status) };
  });
}

function groupByCategory(competencies) {
  const groups = new Map();
  for (const c of competencies) {
    const key = c.category || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return Array.from(groups.entries()).map(([category, items]) => ({ category, items }));
}

function summarize(competencies) {
  const counts = { not_started: 0, prereqs_in_progress: 0, eligible: 0, passed: 0, needs_retest: 0 };
  for (const c of competencies) counts[c.status]++;
  const total = competencies.length;
  const percent = total === 0 ? 0 : Math.round((counts.passed / total) * 100);
  return { total, percent, ...counts };
}

// Clamp an item's progress to [0, target_count] and persist it.
function setItemProgress(studentId, item, newCount) {
  const clamped = Math.max(0, Math.min(item.target_count, newCount));
  db.prepare(
    `INSERT INTO item_progress (student_id, item_id, current_count, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, item_id) DO UPDATE SET
       current_count = excluded.current_count,
       updated_at = datetime('now')`
  ).run(studentId, item.item_id, clamped);
  return clamped;
}

function setExamStatus(studentId, competencyId, examStatus, notes) {
  db.prepare(
    `INSERT INTO competency_progress (student_id, competency_id, exam_status, notes, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, competency_id) DO UPDATE SET
       exam_status = excluded.exam_status,
       notes = excluded.notes,
       updated_at = datetime('now')`
  ).run(studentId, competencyId, examStatus, notes || null);
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  computeStatus,
  getStudentCompetencies,
  groupByCategory,
  summarize,
  setItemProgress,
  setExamStatus,
};
