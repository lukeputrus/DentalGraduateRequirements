const db = require('./index');

// Starting competency sets, each extracted from a school's own documents.
// Double-check each against the school's current requirements before
// students rely on it, and use the admin Competencies page to correct
// anything that's changed (or "Copy from another class year" for other
// classes). A set is only seeded when that school + class year is empty.
const SETS = [
  {
    // From the school's Class of 2028 competency manual PDF.
    school: 'University of Detroit Mercy School of Dentistry',
    classYear: 2028,
    rows: require('../data/detroitMercyClassOf2028.json'),
  },
  {
    // From the requirement columns of an NYU Patient Procedure
    // Experiences (PPE) report: D3/D4 procedure counts, not exams.
    school: 'New York University College of Dentistry',
    classYear: 2027,
    tracking: 'procedure',
    rows: require('../data/nyuPpe.json'),
  },
  {
    // From the Clinical Education Manual - Competency Assessments (July 2026).
    school: 'A.T. Still University Arizona School of Dentistry & Oral Health',
    classYear: 2027,
    rows: require('../data/atsuArizona.json'),
  },
  {
    // From the school's Competency List and its Recommended Procedures for
    // Competencies sheet.
    school: 'Midwestern University College of Dental Medicine – Arizona',
    classYear: 2027,
    rows: require('../data/midwesternArizona.json'),
  },
];

function seedSet({ school: schoolName, classYear, tracking = 'items', rows }) {
  const school = db.prepare('SELECT id FROM schools WHERE name = ?').get(schoolName);
  if (!school) {
    console.log(`Skipping competency seed: school "${schoolName}" not found.`);
    return;
  }

  const existingCount = db
    .prepare('SELECT COUNT(*) AS c FROM competencies WHERE school_id = ? AND class_year = ?')
    .get(school.id, classYear).c;
  if (existingCount > 0) {
    console.log(`${schoolName} Class of ${classYear} already has ${existingCount} competencies; skipping seed.`);
    return;
  }

  const insertCompetency = db.prepare(
    `INSERT INTO competencies (school_id, class_year, dental_year, category, title, description, due_label, source_page,
       sort_order, tracking, d3_required, d4_required, combined_required, requirement_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO competency_items (competency_id, label, item_type, target_count, sort_order) VALUES (?, ?, ?, ?, ?)`
  );

  const seedAll = db.transaction(() => {
    rows.forEach((row, index) => {
      const result = insertCompetency.run(
        school.id,
        classYear,
        row.dental_year || null,
        row.category,
        row.title,
        row.description || null,
        row.due_label || null,
        row.source_page || null,
        index * 10,
        tracking,
        row.d3_required ?? null,
        row.d4_required ?? null,
        row.combined_required ?? null,
        row.requirement_group || null
      );
      (row.items || []).forEach((item, itemIndex) => {
        insertItem.run(result.lastInsertRowid, item.label, item.item_type, item.target_count, itemIndex * 10);
      });
    });
  });
  seedAll();

  const itemTotal = rows.reduce((sum, r) => sum + (r.items || []).length, 0);
  console.log(`Seeded ${rows.length} competencies (${itemTotal} items) for ${schoolName}, Class of ${classYear}.`);
}

function seedCompetencySets() {
  SETS.forEach(seedSet);
}

module.exports = seedCompetencySets;
