const db = require('../db');

function listGoals(studentId) {
  return db
    .prepare(
      `SELECT * FROM goals WHERE student_id = ?
       ORDER BY completed_on IS NOT NULL, target_date IS NULL, target_date, id`
    )
    .all(studentId);
}

function addGoal({ studentId, setBy, setByName, title, detail, targetDate }) {
  db.prepare(
    `INSERT INTO goals (student_id, set_by, set_by_name, title, detail, target_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(studentId, setBy, setByName || null, title.slice(0, 200), (detail || '').slice(0, 1000) || null, targetDate || null);
}

module.exports = { listGoals, addGoal };
