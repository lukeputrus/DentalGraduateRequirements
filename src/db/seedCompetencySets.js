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
  // Class of 2030 (entering 2026) sets from public documents; see
  // docs/school-requirements-sources.md for sources and caveats.
  {
    // Annual Assessment Report to the IUPUI Program Review and Assessment Committee: Doctor of Dental Surgery Program (Table 1: IUSD Institutional Competency Statements Mapped to Competency Assessments) (2022-23 academic year assessment report).
    // https://planning.indianapolis.iu.edu/assessment/prac-files/school-reports/2022-23/dentistry_dds22-23.pdf
    school: 'Indiana University School of Dentistry',
    classYear: 2030,
    rows: require('../data/classOf2030/indianaUniversitySchoolOfDentistry2030.json'),
  },
  {
    // MUSC Bulletin - Dental Medicine course descriptions; CDM Doctor of Dental Medicine curriculum page (Current MUSC Bulletin / DMD curriculum webpage (accessed Oct 2026; edition year not stated)).
    // https://bulletin.musc.edu/course-descriptions/dental-medicine
    school: 'Medical University of South Carolina College of Dental Medicine',
    classYear: 2030,
    rows: require('../data/classOf2030/medicalUniversityOfSouthCarolinaCollegeOfDentalMedicine2030.json'),
  },
  {
    // College of Dental Medicine Student Handbook 2025-2026 (2025-2026 Student Handbook).
    // https://www.roseman.edu/app/uploads/2025/06/CODM-Student-Handbook-2025-2026.pdf
    school: 'Roseman University of Health Sciences College of Dental Medicine',
    classYear: 2030,
    rows: require('../data/classOf2030/rosemanUniversityOfHealthSciencesCollegeOfDentalMedicine2030.json'),
  },
  {
    // UConn School of Dental Medicine Competency Manual (Academic Year 2015-2016 Competency Manual (most recent publicly posted)).
    // https://dentalmedicine.uconn.edu/wp-content/uploads/sites/1605/2017/01/manual_competency.pdf
    school: 'University of Connecticut School of Dental Medicine',
    classYear: 2030,
    rows: require('../data/classOf2030/universityOfConnecticutSchoolOfDentalMedicine2030.json'),
  },
  {
    // School of Dentistry Competency Statements and Competency Examinations (2025-2026 academic year (D2-D4 competency exam list)).
    // https://www.dental.umaryland.edu/sod-2026/current-students/competencies/
    school: 'University of Maryland School of Dentistry',
    classYear: 2030,
    rows: require('../data/classOf2030/universityOfMarylandSchoolOfDentistry2030.json'),
  },
  {
    // UNLV SDM Predoctoral Course Objectives / Clinical Competency Assessment (Learning outcome) Map (Undated (posted on UNLV DMD degree page; current as of 2026 web listing)).
    // https://www.unlv.edu/sites/default/files/degrees/downloads/CourseObjectives-Dental-PreDoc_0.pdf
    school: 'University of Nevada, Las Vegas, School of Dental Medicine',
    classYear: 2030,
    rows: require('../data/classOf2030/universityOfNevadaLasVegasSchoolOfDentalMedicine2030.json'),
  },
  {
    // OU College of Dentistry Clinical Requirements (ClnRequirements-1-16-19) (Dated 1/16/2019 (2018-2019 academic year; DS2-DS4)).
    // https://dentistry.ouhsc.edu/Portals/1328/assets/Documents/Current%20Students/Manuals/ClnRequirements-1-16-19.pdf
    school: 'University of Oklahoma College of Dentistry',
    classYear: 2030,
    rows: require('../data/classOf2030/universityOfOklahomaCollegeOfDentistry2030.json'),
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
