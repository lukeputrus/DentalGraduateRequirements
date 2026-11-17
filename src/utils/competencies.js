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

// How each status reads on screen. Colour never carries the meaning on its
// own: every status has a glyph and a word, so it survives greyscale
// printing and colour-vision differences. `order` sorts the "Status" view
// with the things that need action first.
const STATUS_DISPLAY = {
  needs_retest: { label: 'Failed, remediation', glyph: '✕', cls: 'st-failed', order: 1 },
  eligible: { label: 'Eligible to attempt', glyph: '▶', cls: 'st-eligible', order: 2 },
  prereqs_in_progress: { label: 'Prerequisites in progress', glyph: '●', cls: 'st-progress', order: 3 },
  not_started: { label: 'Prerequisites unmet', glyph: '—', cls: 'st-blocked', order: 4 },
  passed: { label: 'Passed', glyph: '✓', cls: 'st-passed', order: 5 },
  tracking_only: { label: 'Tracking only', glyph: '·', cls: 'st-blocked', order: 6 },
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
              cp.assessed_by, cp.assessed_on,
              COALESCE(pp.d3_count, 0) AS d3_count, COALESCE(pp.d4_count, 0) AS d4_count,
              COALESCE(sn.starred, 0) AS starred, sn.note AS my_note, sn.reminder_on
       FROM competencies c
       LEFT JOIN competency_progress cp ON cp.competency_id = c.id AND cp.student_id = ?
       LEFT JOIN procedure_progress pp ON pp.competency_id = c.id AND pp.student_id = ?
       LEFT JOIN student_competency_notes sn ON sn.competency_id = c.id AND sn.student_id = ?
       WHERE c.school_id = ? AND c.class_year = ?
       ORDER BY c.category, c.sort_order, c.id`
    )
    .all(student.id, student.id, student.id, student.school_id, student.class_year);

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
      if (c.tracking === 'procedure') {
        return { ...c, items: [], items_met: 0, items_total: 0, ...computeProcedureStatus(c) };
      }
      const items = itemStmt.all(student.id, c.id);
      return {
        ...c,
        items,
        items_met: items.filter((i) => i.current_count >= i.target_count).length,
        items_total: items.length,
        status: computeStatus(items, c.exam_status),
        status_label: null,
      };
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

// Records an exam outcome, plus who recorded it and when. Clearing the
// outcome (not_attempted) clears the assessor too.
function setExamStatus(studentId, competencyId, examStatus, notes, assessedBy) {
  const recorded = examStatus !== 'not_attempted';
  db.prepare(
    `INSERT INTO competency_progress (student_id, competency_id, exam_status, notes, assessed_by, assessed_on, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, competency_id) DO UPDATE SET
       exam_status = excluded.exam_status,
       notes = excluded.notes,
       assessed_by = excluded.assessed_by,
       assessed_on = CASE
         WHEN excluded.assessed_on IS NULL THEN NULL
         WHEN competency_progress.exam_status = excluded.exam_status AND competency_progress.assessed_on IS NOT NULL
           THEN competency_progress.assessed_on
         ELSE excluded.assessed_on END,
       updated_at = datetime('now')`
  ).run(
    studentId,
    competencyId,
    examStatus,
    notes || null,
    recorded ? assessedBy || null : null,
    recorded ? todayISO() : null
  );
}

// ---------- Dates ----------

const DAY_MS = 864e5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00'));
}

function parseISO(s) {
  return new Date(String(s).slice(0, 10) + 'T12:00:00');
}

function fmtDate(s) {
  if (!s) return '';
  const d = parseISO(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function daysUntil(s, today = todayISO()) {
  return Math.round((parseISO(s) - parseISO(today)) / DAY_MS);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// How close a deadline is, as a band plus a label. The bands match the
// mockup: overdue / within a month / within four months / later.
function urgency(dueDate, today = todayISO()) {
  if (!dueDate) return { band: 'none', days: 1e6, label: 'No stated deadline', tag: 'tag-flat' };
  const days = daysUntil(dueDate, today);
  if (days < 0) return { band: 'overdue', days, label: `${plural(-days, 'day')} overdue`, tag: 'tag-bad' };
  if (days <= 31) return { band: 'now', days, label: `${plural(days, 'day')} remaining`, tag: 'tag-bad' };
  if (days <= 120) return { band: 'soon', days, label: `${plural(Math.round(days / 7), 'week')} remaining`, tag: 'tag-warn' };
  const d = parseISO(dueDate);
  return { band: 'later', days, label: `Due ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`, tag: 'tag-flat' };
}

// The app doesn't store graduation dates, so it assumes mid-May of the
// class year (the usual US dental commencement window).
function graduationDate(classYear) {
  return classYear ? `${classYear}-05-15` : null;
}

function weeksToGraduation(classYear, today = todayISO()) {
  const g = graduationDate(classYear);
  return g ? Math.max(0, Math.round(daysUntil(g, today) / 7)) : null;
}

// ---------- Student annotations (star, note, reminder) ----------

function getNotes(studentId, competencyId) {
  return (
    db
      .prepare('SELECT * FROM student_competency_notes WHERE student_id = ? AND competency_id = ?')
      .get(studentId, competencyId) || { starred: 0, note: null, reminder_on: null }
  );
}

function saveNotes(studentId, competencyId, changes) {
  const current = getNotes(studentId, competencyId);
  const next = { ...current, ...changes };
  db.prepare(
    `INSERT INTO student_competency_notes (student_id, competency_id, starred, note, reminder_on, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(student_id, competency_id) DO UPDATE SET
       starred = excluded.starred, note = excluded.note, reminder_on = excluded.reminder_on,
       updated_at = datetime('now')`
  ).run(studentId, competencyId, next.starred ? 1 : 0, next.note || null, next.reminder_on || null);
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
  STATUS_DISPLAY,
  todayISO,
  isISODate,
  fmtDate,
  daysUntil,
  urgency,
  plural,
  graduationDate,
  weeksToGraduation,
  getNotes,
  saveNotes,
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
