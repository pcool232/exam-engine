'use strict';
/**
 * Small decorative icons for subjects and exam levels/categories.
 * Plain emoji -- no image files, no dependency, renders everywhere.
 */

const CATEGORY_ICONS = {
  PSLE: '🎒',
  JC: '📗',
  BGCSE: '🎓',
};

const CATEGORY_LABELS = {
  PSLE: 'Primary School Leaving Examination',
  JC: 'Junior Certificate',
  BGCSE: 'Botswana General Certificate of Secondary Education',
};

/** Icon for a Botswana exam level/category (PSLE / JC / BGCSE). */
function categoryIcon(category) {
  const key = String(category || '').trim().toUpperCase();
  return CATEGORY_ICONS[key] || '🏫';
}

/** Full name for a category code, falling back to the code itself. */
function categoryLabel(category) {
  const key = String(category || '').trim().toUpperCase();
  return CATEGORY_LABELS[key] || key || 'Not set';
}

// Ordered keyword -> icon. First match wins, so put more specific
// keywords (e.g. "computer") before general ones.
const SUBJECT_ICONS = [
  [/math/i, '🧮'],
  [/english|literature|language/i, '📖'],
  [/setswana/i, '🗣️'],
  [/french|spanish|portuguese|mandarin|chinese/i, '🌐'],
  [/physic/i, '⚛️'],
  [/chemist/i, '🧪'],
  [/biolog/i, '🧬'],
  [/(^|\W)science/i, '🔬'],
  [/agricultur/i, '🌱'],
  [/computer|ict|information technology/i, '💻'],
  [/design|technology|technical/i, '🛠️'],
  [/geograph/i, '🗺️'],
  [/histor/i, '🏛️'],
  [/social studies|civic/i, '🌍'],
  [/religious|moral/i, '🕊️'],
  [/account/i, '🧾'],
  [/business|commerce|entrepreneur/i, '💼'],
  [/econom/i, '📊'],
  [/art|design and craft/i, '🎨'],
  [/music/i, '🎵'],
  [/physical education|\bpe\b|sport/i, '⚽'],
  [/home economics|food|nutrition/i, '🍲'],
  [/health/i, '🩺'],
];

/** Icon for a subject name, guessed from keywords. Falls back to a book. */
function subjectIcon(subject) {
  const name = String(subject || '');
  for (const [pattern, icon] of SUBJECT_ICONS) {
    if (pattern.test(name)) return icon;
  }
  return '📄';
}

module.exports = { categoryIcon, categoryLabel, subjectIcon };
