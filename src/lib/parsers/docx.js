'use strict';
/**
 * Extract plain text from a .docx file using only node:zlib.
 *
 * A .docx is a ZIP archive; the text lives in word/document.xml. We read the
 * ZIP central directory, inflate that one entry, and convert the paragraph
 * markup back into lines. The result is then fed to the past-paper text parser.
 */

const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 66 * 1024);
  for (let i = buffer.length - 22; i >= minimum; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Return a Map of entry name -> { compressionMethod, offset, compressedSize }. */
function readCentralDirectory(buffer) {
  const entries = new Map();
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw new Error('Not a valid ZIP/DOCX file (no end-of-central-directory record).');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let position = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (position + 46 > buffer.length) break;
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) break;

    const compressionMethod = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.slice(position + 46, position + 46 + nameLength).toString('utf8');

    entries.set(name, { compressionMethod, compressedSize, localOffset });
    position += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntry(buffer, entry) {
  const { localOffset, compressionMethod, compressedSize } = entry;
  // Local file header: name and extra field lengths can differ from the central one.
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const data = buffer.slice(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return data;
  if (compressionMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Convert WordprocessingML into plain text lines. */
function documentXmlToText(xml) {
  let text = xml;

  // Paragraph and line breaks become newlines; tabs become spaces.
  text = text.replace(/<w:br\b[^>]*\/?>/g, '\n');
  text = text.replace(/<w:tab\b[^>]*\/?>/g, ' ');
  text = text.replace(/<\/w:p>/g, '\n');
  text = text.replace(/<\/w:tr>/g, '\n');
  text = text.replace(/<\/w:tc>/g, ' ');

  // Keep only the contents of <w:t> elements.
  const pieces = [];
  const tagPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\n)/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    pieces.push(match[1] !== undefined ? match[1] : '\n');
  }

  return decodeXmlEntities(pieces.join(''))
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocxText(buffer) {
  const entries = readCentralDirectory(buffer);
  const target = entries.get('word/document.xml');
  if (!target) throw new Error('This does not look like a Word document (word/document.xml is missing).');
  const xml = readEntry(buffer, target).toString('utf8');
  return documentXmlToText(xml);
}

module.exports = { extractDocxText, documentXmlToText };
