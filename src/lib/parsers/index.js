'use strict';
/** Dispatches an upload or a paste to the right parser. */

const path = require('node:path');
const { parseExamText } = require('./text');
const { parseCsvQuestions } = require('./csv');
const { parseJsonQuestions } = require('./json');
const { extractDocxText } = require('./docx');
const { extractPdfText } = require('./pdf');

const FORMAT_LABELS = {
  text: 'Past-paper text',
  csv: 'CSV spreadsheet',
  json: 'JSON',
  docx: 'Word document',
  pdf: 'PDF document',
};

function detectFormat(filename, content) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension === '.csv' || extension === '.tsv') return 'csv';
  if (extension === '.json') return 'json';
  if (extension === '.docx') return 'docx';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.txt' || extension === '.md') return 'text';

  if (Buffer.isBuffer(content)) {
    if (content.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (content.slice(0, 2).toString('latin1') === 'PK') return 'docx';
  }

  const sample = (Buffer.isBuffer(content) ? content.slice(0, 2048).toString('utf8') : String(content || '')).trim();
  if (sample.startsWith('[') || sample.startsWith('{')) return 'json';
  return 'text';
}

/**
 * Parse content into { questions, issues, format, extractedText }.
 * `content` is a Buffer (upload) or a string (pasted text).
 */
function parseQuestions(content, { filename = '', format = 'auto' } = {}) {
  const chosenFormat = format && format !== 'auto' ? format : detectFormat(filename, content);
  const asBuffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const asText = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);

  let extractedText = null;
  let result;

  switch (chosenFormat) {
    case 'csv':
      result = parseCsvQuestions(asText);
      break;
    case 'json':
      result = parseJsonQuestions(asText);
      break;
    case 'docx':
      extractedText = extractDocxText(asBuffer);
      result = parseExamText(extractedText);
      break;
    case 'pdf':
      extractedText = extractPdfText(asBuffer);
      result = parseExamText(extractedText);
      break;
    case 'text':
    default:
      result = parseExamText(asText);
      break;
  }

  return {
    exam: null, // overwritten below when the file carries its own settings
    ...result,
    format: chosenFormat,
    formatLabel: FORMAT_LABELS[chosenFormat] || chosenFormat,
    extractedText,
  };
}

module.exports = { parseQuestions, detectFormat, FORMAT_LABELS };
