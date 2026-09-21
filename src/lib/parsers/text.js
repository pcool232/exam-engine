'use strict';
/**
 * Parser for past examination papers pasted as plain text.
 *
 * It copes with the layouts you normally find in exam dumps and past papers:
 *
 *   1. What is the capital city of Kenya?      |   Question 12
 *   A. Mombasa                                 |   Which TWO are valid? (Choose two)
 *   B. Nairobi                                 |   A) TCP
 *   C. Kisumu                                  |   B) UDP
 *   Answer: B                                  |   C) ICMP
 *   Explanation: Nairobi has been ...          |   Correct Answers: A, B
 *
 * A leading asterisk also marks the correct option:  *B. Nairobi
 *
 * Returns { questions, issues } - issues describe anything that could not be
 * turned into a usable question, so the admin can fix the source text.
 */

const OPTION_PATTERNS = [
  // "A. text" | "A) text" | "A: text" | "A - text"
  /^\s*(\*|✓)?\s*([A-Ja-j])\s*[.):\-]\s+(.*)$/,
  // "(A) text"
  /^\s*(\*|✓)?\s*\(([A-Ja-j])\)\s*(.*)$/,
];

const ANSWER_PATTERN =
  /^\s*(?:correct\s+)?(?:answers?|ans|key|solution)\s*(?:is|=)?\s*[:.\-]?\s*(.+?)\s*$/i;

const EXPLANATION_PATTERN =
  /^\s*(?:explanation|rationale|reason|why|note)s?\s*[:.\-]\s*(.*)$/i;

// "Question 4", "Q4.", "Q. 4 - ..." - the word makes the delimiter optional.
const LABELLED_QUESTION_PATTERN =
  /^\s*(?:question|ques|q)\s*\.?\s*(\d{1,4})\s*[.):\-]?\s*(.*)$/i;

// "4. ...", "4) ...", "#4 - ..." - a delimiter is required here.
const QUESTION_PATTERN = /^\s*#?(\d{1,4})\s*[.):\-]\s+(.*)$/;

const BARE_QUESTION_PATTERN = /^\s*(?:question|q)\s*[:.\-]\s*(.+)$/i;

const MULTI_HINT =
  /\((?:choose|select|pick)\s+(?:any\s+)?(two|three|four|2|3|4|all that apply|all correct)[^)]*\)|choose\s+all\s+that\s+apply|select\s+all\s+that\s+apply/i;

function matchOption(line) {
  for (const pattern of OPTION_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return {
        starred: Boolean(match[1]),
        label: match[2].toUpperCase(),
        text: match[3].trim(),
      };
    }
  }
  return null;
}

/** Turn "B", "A, C", "AC", "B) Nairobi" or full option text into label list. */
function resolveAnswerLabels(answerText, options) {
  const cleaned = String(answerText || '').trim().replace(/[.;]+$/, '');
  if (!cleaned) return [];

  const labels = new Set();
  const validLabels = new Set(options.map((o) => o.label));

  // Split on commas / "and" / slashes / spaces
  const tokens = cleaned.split(/[,;/&]+|\s+and\s+/i).map((t) => t.trim()).filter(Boolean);

  for (const token of tokens) {
    // "B" or "B)" or "(B)" or "B. Nairobi"
    const direct = token.match(/^\(?([A-Ja-j])\)?\s*[.):\-]?\s*(.*)$/);
    if (direct && validLabels.has(direct[1].toUpperCase())) {
      labels.add(direct[1].toUpperCase());
      continue;
    }
    // "AC" or "ABD" - run-together labels
    if (/^[A-Ja-j]{2,}$/.test(token) && [...token].every((c) => validLabels.has(c.toUpperCase()))) {
      for (const char of token) labels.add(char.toUpperCase());
      continue;
    }
    // Match against the option text itself.
    const normalised = token.toLowerCase().replace(/\s+/g, ' ');
    const hit = options.find(
      (o) => o.text.toLowerCase().replace(/\s+/g, ' ') === normalised
    );
    if (hit) labels.add(hit.label);
  }

  // Whole answer line equals one option's text.
  if (labels.size === 0) {
    const normalised = cleaned.toLowerCase().replace(/\s+/g, ' ');
    const hit = options.find((o) => o.text.toLowerCase().replace(/\s+/g, ' ') === normalised);
    if (hit) labels.add(hit.label);
  }

  return [...labels];
}

function parseExamText(input) {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n');

  const questions = [];
  const issues = [];

  let current = null;
  let state = 'idle'; // idle | question | options | explanation
  let sourceLine = 0;

  const startQuestion = (text, lineNumber) => {
    flush();
    current = {
      text: text.trim(),
      options: [],
      answerLabels: [],
      explanation: '',
      type: 'single',
      marks: 1,
      line: lineNumber,
    };
    state = 'question';
  };

  function flush() {
    if (!current) return;
    const question = current;
    current = null;

    question.text = question.text.replace(/\s+\n/g, '\n').trim();
    if (!question.text) return;

    const reference = `line ${question.line}: "${question.text.slice(0, 70)}${question.text.length > 70 ? '…' : ''}"`;

    if (question.options.length < 2) {
      issues.push({ reference, problem: 'Fewer than two options were found - skipped.' });
      return;
    }

    let correctLabels = resolveAnswerLabels(question.answerLabels.join(', '), question.options);
    const starred = question.options.filter((o) => o.starred).map((o) => o.label);
    if (starred.length > 0) correctLabels = [...new Set([...correctLabels, ...starred])];

    if (correctLabels.length === 0) {
      issues.push({ reference, problem: 'No correct answer could be identified - skipped.' });
      return;
    }

    const isMultiple = correctLabels.length > 1 || MULTI_HINT.test(question.text);

    questions.push({
      text: question.text,
      type: isMultiple ? 'multiple' : 'single',
      explanation: question.explanation.trim() || null,
      marks: question.marks,
      options: question.options.map((option) => ({
        label: option.label,
        text: option.text,
        isCorrect: correctLabels.includes(option.label),
      })),
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    sourceLine = i + 1;

    if (!line.trim()) {
      if (state === 'explanation') state = 'idle';
      continue;
    }

    // Skip page furniture found in scanned papers.
    if (/^\s*(page\s+\d+\s*(of\s+\d+)?|-+\s*\d+\s*-+)\s*$/i.test(line)) continue;

    const answerMatch = line.match(ANSWER_PATTERN);
    if (answerMatch && current && current.options.length > 0) {
      current.answerLabels.push(answerMatch[1]);
      state = 'answered';
      continue;
    }

    const explanationMatch = line.match(EXPLANATION_PATTERN);
    if (explanationMatch && current) {
      current.explanation += (current.explanation ? ' ' : '') + explanationMatch[1].trim();
      state = 'explanation';
      continue;
    }

    if (state === 'explanation' && current) {
      current.explanation += ' ' + line.trim();
      continue;
    }

    const option = matchOption(line);
    // A line like "A. something" only counts as an option while a question is open.
    if (option && current && (state === 'question' || state === 'options')) {
      // Guard against a question that simply begins with "A. " - require that
      // labels progress sensibly (first option is A or B, later ones increase).
      const expectedIndex = current.options.length;
      const labelIndex = option.label.charCodeAt(0) - 65;
      if (expectedIndex === 0 || labelIndex > current.options[expectedIndex - 1].label.charCodeAt(0) - 65) {
        current.options.push(option);
        state = 'options';
        continue;
      }
    }

    // "Question 7" always begins a new question, even on its own line.
    const labelled = line.match(LABELLED_QUESTION_PATTERN);
    if (labelled) {
      startQuestion(labelled[2], sourceLine);
      continue;
    }

    const numbered = line.match(QUESTION_PATTERN);
    if (numbered && (state !== 'options' || numbered[2].length > 0)) {
      startQuestion(numbered[2], sourceLine);
      continue;
    }

    const bare = line.match(BARE_QUESTION_PATTERN);
    if (bare) {
      startQuestion(bare[1], sourceLine);
      continue;
    }

    if (state === 'question' && current) {
      current.text += ' ' + line.trim();
      continue;
    }

    if (state === 'options' && current && current.options.length > 0) {
      // Wrapped option text.
      current.options[current.options.length - 1].text += ' ' + line.trim();
      continue;
    }

    // Anything else starts a new (unnumbered) question.
    startQuestion(line, sourceLine);
  }

  flush();
  return { questions, issues };
}

module.exports = { parseExamText, resolveAnswerLabels };
