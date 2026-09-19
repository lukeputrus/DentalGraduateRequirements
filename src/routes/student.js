const express = require('express');
const db = require('../db');
const { requireStudent } = require('../middleware/auth');
const { verifyCsrfToken } = require('../middleware/csrf');
const {
  STATUS_LABELS,
  getStudentCompetencies,
  groupByCategory,
  summarize,
  setItemProgress,
} = require('../utils/competencies');

const router = express.Router();

router.use(requireStudent);

function getOwnedItem(student, itemId) {
  return db
    .prepare(
      `SELECT ci.id AS item_id, ci.target_count, ci.competency_id,
              COALESCE(ip.current_count, 0) AS current_count
       FROM competency_items ci
       JOIN competencies c ON c.id = ci.competency_id
       LEFT JOIN item_progress ip ON ip.item_id = ci.id AND ip.student_id = ?
       WHERE ci.id = ? AND c.school_id = ? AND c.class_year = ?`
    )
    .get(student.id, itemId, student.school_id, student.class_year);
}

router.get('/dashboard', (req, res) => {
  const student = req.currentUser;
  if (!student.school_id || !student.class_year) {
    return res.render('student/dashboard', {
      needsSetup: true,
      groups: [],
      competencies: [],
      summary: null,
      school: null,
      statusLabels: STATUS_LABELS,
    });
  }

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(student.school_id);
  const competencies = getStudentCompetencies(student);
  const groups = groupByCategory(competencies);
  const summary = summarize(competencies);
  const categorySummaries = groups.map((g) => ({ category: g.category, ...summarize(g.items) }));

  res.render('student/dashboard', {
    needsSetup: false,
    groups,
    competencies,
    summary,
    categorySummaries,
    school,
    statusLabels: STATUS_LABELS,
  });
});

function handleItemUpdate(req, res, computeNext) {
  const student = req.currentUser;
  const item = getOwnedItem(student, parseInt(req.params.itemId, 10));
  if (!item) {
    return res.status(400).render('errors/403', { message: 'That item does not apply to your account.' });
  }
  setItemProgress(student.id, item, computeNext(item));
  res.redirect('/student/dashboard#comp-' + item.competency_id);
}

router.post('/items/:itemId/increment', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => item.current_count + 1);
});

router.post('/items/:itemId/decrement', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => item.current_count - 1);
});

router.post('/items/:itemId/toggle', verifyCsrfToken, (req, res) => {
  handleItemUpdate(req, res, (item) => (item.current_count > 0 ? 0 : item.target_count));
});

module.exports = router;
