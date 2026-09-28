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

// A small palette of {accent, soft} color pairs handed out to subjects by
// name, so "Mathematics" always gets the same card color across renders and
// sessions without storing a color anywhere -- just a stable hash of the
// subject's name. Deliberately separate hues from the category colors
// (icons above/CSS :root) since they're never shown side by side.
const SUBJECT_PALETTE = [
  { accent: '#4353c9', soft: '#e7e9fb' }, // indigo
  { accent: '#c23a6b', soft: '#fbe3ec' }, // rose
  { accent: '#0f8b8d', soft: '#dff3f3' }, // teal
  { accent: '#6d43a6', soft: '#f1e9fa' }, // purple
  { accent: '#d9622b', soft: '#fbe7d9' }, // coral
  { accent: '#1f7fc9', soft: '#e2f1fb' }, // sky blue
  { accent: '#4c7a1f', soft: '#ecf3df' }, // olive
  { accent: '#a6742f', soft: '#f6ecdb' }, // sand
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** A stable {accent, soft} color pair for a subject name (case-insensitive). */
function subjectColor(subject) {
  const key = String(subject || '').trim().toLowerCase() || 'default';
  return SUBJECT_PALETTE[hashString(key) % SUBJECT_PALETTE.length];
}

module.exports = { categoryIcon, categoryLabel, subjectIcon, subjectColor };
