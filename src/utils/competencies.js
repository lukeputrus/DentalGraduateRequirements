const db = require('../db');

const STATUSES = ['not_started', 'prereqs_in_progress', 'eligible', 'passed', 'needs_retest', 'tracking_only'];

const STATUS_LABELS = {
  not_started: 'Not started',
  prereqs_in_progress: 'Prereqs in progress',
  eligible: 'Eligible / ready',
  passed: 'Passed',
  needs_retest: 'Needs retest',
  tracking_only: 'Tracking only',
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

function isMet(count, required) {
  return required == null || count >= required;
}

// Status for a 'procedure' competency from its D3/D4 counts. A blank
// requirement is no requirement; a row with none at all is just logged
// ("tracking only") and never counts toward the pass percentage. Returns
// a status bucket plus an optional label that mirrors NYU's report wording.
function computeProcedureStatus(c) {
  const d3 = c.d3_count || 0;
  const d4 = c.d4_count || 0;
  if (c.d3_required == null && c.d4_required == null && c.combined_required == null) {
    return { status: 'tracking_only', status_label: null };
  }
  const d3Met = isMet(d3, c.d3_required);
  const allMet = d3Met && isMet(d4, c.d4_required) && isMet(d3 + d4, c.combined_required);
  if (allMet) return { status: 'passed', status_label: 'PPE complete' };
  if (c.d3_required > 0 && d3Met) return { status: 'prereqs_in_progress', status_label: 'D3 PPE complete' };
  if (d3 + d4 > 0) return { status: 'prereqs_in_progress', status_label: 'In progress' };
  return { status: 'not_started', status_label: null };
}

// Grouped procedure rows are only complete together: if any row in the
// group still falls short, rows that met their own numbers are held back.
function applyRequirementGroups(competencies) {
  const groups = new Map();
  for (const c of competencies) {
    if (c.tracking !== 'procedure' || !c.requirement_group) continue;
    const key = `${c.category}\u0000${c.requirement_group}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const members of groups.values()) {
    const complete = members.every((m) => m.status === 'passed' || m.status === 'tracking_only');
    for (const m of members) {
      m.group_complete = complete;
      if (!complete && m.status === 'passed') {
        m.status = 'prereqs_in_progress';
        m.status_label = 'Met; group incomplete';
      }
    }
  }
  return competencies;
}

// Returns every competency for a student's school + class year, each with
// its items (left-joined with that student's own item_progress) and a
// computed overall status.
function getStudentCompetencies(student) {
  if (!student.school_id || !student.class_year) return [];

  const competencies = db
    .prepare(
      `SELECT c.*, COALESCE(cp.exam_status, 'not_attempted') AS exam_status, cp.notes AS exam_notes,
              COALESCE(pp.d3_count, 0) AS d3_count, COALESCE(pp.d4_count, 0) AS d4_count
       FROM competencies c
       LEFT JOIN competency_progress cp ON cp.competency_id = c.id AND cp.student_id = ?
       LEFT JOIN procedure_progress pp ON pp.competency_id = c.id AND pp.student_id = ?
       WHERE c.school_id = ? AND c.class_year = ?
       ORDER BY c.category, c.sort_order, c.id`
    )
    .all(student.id, student.id, student.school_id, student.class_year);

  const itemStmt = db.prepare(
    `SELECT ci.id AS item_id, ci.label, ci.item_type, ci.target_count,
            COALESCE(ip.current_count, 0) AS current_count
     FROM competency_items ci
     LEFT JOIN item_progress ip ON ip.item_id = ci.id AND ip.student_id = ?
     WHERE ci.competency_id = ?
     ORDER BY ci.sort_order, ci.id`
  );

  return applyRequirementGroups(
    competencies.map((c) => {
      if (c.tracking === 'procedure') return { ...c, items: [], ...computeProcedureStatus(c) };
      const items = itemStmt.all(student.id, c.id);
      return { ...c, items, status: computeStatus(items, c.exam_status), status_label: null };
    })
  );
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
  const counts = { not_started: 0, prereqs_in_progress: 0, eligible: 0, passed: 0, needs_retest: 0, tracking_only: 0 };
  for (const c of competencies) counts[c.status]++;
  const total = competencies.length - counts.tracking_only;
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

function setProcedureProgress(studentId, competencyId, d3Count, d4Count) {
  const clean = (n) => (Number.isInteger(n) && n > 0 ? Math.min(n, 9999) : 0);
  db.prepare(
    `INSERT INTO procedure_progress (student_id, competency_id, d3_count, d4_count, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, competency_id) DO UPDATE SET
       d3_count = excluded.d3_count,
       d4_count = excluded.d4_count,
       updated_at = datetime('now')`
  ).run(studentId, competencyId, clean(d3Count), clean(d4Count));
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  computeStatus,
  computeProcedureStatus,
  applyRequirementGroups,
  getStudentCompetencies,
  groupByCategory,
  summarize,
  setItemProgress,
  setExamStatus,
  setProcedureProgress,
};
