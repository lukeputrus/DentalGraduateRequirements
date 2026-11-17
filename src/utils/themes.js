// Institution themes. Every theme is one [data-institution="key"] block in
// public/css/style.css that redefines the palette custom properties, so
// adding a school's look means adding one CSS block and one entry here.
const THEMES = [
  { key: 'charcoal', label: 'Charcoal and beige' },
  { key: 'mercy', label: 'Navy and burgundy' },
  { key: 'violet', label: 'Violet' },
  { key: 'teal', label: 'Clinical teal' },
];
const DEFAULT_THEME = 'charcoal';
const THEME_KEYS = new Set(THEMES.map((t) => t.key));

// Starting theme for seeded schools. Admins can change any school's theme
// on the Schools page, and each user can override it from the top bar.
const SCHOOL_DEFAULT_THEMES = {
  'University of Detroit Mercy School of Dentistry': 'charcoal',
  'New York University College of Dentistry': 'violet',
};

function isTheme(key) {
  return THEME_KEYS.has(key);
}

// The user's own choice wins, then their school's, then the app default.
function resolveTheme(user, school) {
  if (user && isTheme(user.theme)) return user.theme;
  if (school && isTheme(school.theme)) return school.theme;
  return DEFAULT_THEME;
}

module.exports = { THEMES, DEFAULT_THEME, SCHOOL_DEFAULT_THEMES, isTheme, resolveTheme };
