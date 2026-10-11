const db = require('./index');
const requirements = require('../data/nyuPpe.json');

const SCHOOL_NAME = 'New York University College of Dentistry';
const CLASS_YEAR = 2027;

// Seeds NYU Dentistry's Patient Procedure Experiences (PPE) requirements:
// procedure counts logged in D3 and D4 against D3, D4 and/or combined
// minimums. Taken from the requirement columns of an NYU PPE report; check
// against NYU's current numbers before students rely on them, and use the
// admin Competencies page (or "Copy from another class year") for other
// classes.
function seedNyuRequirements() {
  const school = db.prepare('SELECT id FROM schools WHERE name = ?').get(SCHOOL_NAME);
  if (!school) {
    console.log(`Skipping NYU seed: school "${SCHOOL_NAME}" not found.`);
    return;
  }

  const existingCount = db
    .prepare('SELECT COUNT(*) AS c FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(school.id, CLASS_YEAR).c;
  if (existingCount > 0) {
    console.log(`NYU Class of ${CLASS_YEAR} already has ${existingCount} requirements; skipping seed.`);
    return;
  }

  const insert = db.prepare(
    `INSERT INTO competencies (school_id, class_year, category, title, description, sort_order,
       tracking, d3_required, d4_required, combined_required, requirement_group)
     VALUES (?, ?, ?, ?, ?, ?, 'procedure', ?, ?, ?, ?)`
  );
  const seedAll = db.transaction((rows) => {
    rows.forEach((row, index) => {
      insert.run(
        school.id,
        CLASS_YEAR,
        row.category,
        row.title,
        row.description || null,
        index * 10,
        row.d3_required,
        row.d4_required,
        row.combined_required,
        row.requirement_group || null
      );
    });
  });
  seedAll(requirements);

  console.log(`Seeded ${requirements.length} NYU PPE requirements for the Class of ${CLASS_YEAR}.`);
}

module.exports = seedNyuRequirements;
