const db = require('./index');
const competencies = require('../data/detroitMercyClassOf2028.json');

const SCHOOL_NAME = 'University of Detroit Mercy School of Dentistry';
const CLASS_YEAR = 2028;

// Seeds the real Class of 2028 competency manual for Detroit Mercy as a
// starting example. Extracted from the school's own competency manual PDF;
// double-check against the current manual before students rely on it, and
// use the admin Competencies page to correct anything that's changed.
function seedDetroitMercyCompetencies() {
  const school = db.prepare('SELECT id FROM schools WHERE name = ?').get(SCHOOL_NAME);
  if (!school) {
    console.log(`Skipping Detroit Mercy competency seed: school "${SCHOOL_NAME}" not found.`);
    return;
  }

  const existingCount = db
    .prepare('SELECT COUNT(*) AS c FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(school.id, CLASS_YEAR).c;
  if (existingCount > 0) {
    console.log(`Detroit Mercy Class of ${CLASS_YEAR} already has ${existingCount} competencies; skipping seed.`);
    return;
  }

  const insertCompetency = db.prepare(
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, source_page, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO competency_items (competency_id, label, item_type, target_count, sort_order) VALUES (?, ?, ?, ?, ?)`
  );

  const seedAll = db.transaction((rows) => {
    rows.forEach((row, index) => {
      const result = insertCompetency.run(
        school.id,
        CLASS_YEAR,
        row.dental_year || null,
        row.category,
        row.title,
        row.description || null,
        row.source_page || null,
        index * 10
      );
      const competencyId = result.lastInsertRowid;
      row.items.forEach((item, itemIndex) => {
        insertItem.run(competencyId, item.label, item.item_type, item.target_count, itemIndex * 10);
      });
    });
  });
  seedAll(competencies);

  const itemTotal = competencies.reduce((sum, c) => sum + c.items.length, 0);
  console.log(`Seeded ${competencies.length} Detroit Mercy competencies (${itemTotal} items) for the Class of ${CLASS_YEAR}.`);
}

module.exports = seedDetroitMercyCompetencies;
