'use strict';
/**
 * Best-effort PDF text extraction using only node:zlib.
 *
 * It inflates FlateDecode content streams and reads the text-showing
 * operators (Tj, TJ, ', "). That covers most digitally produced papers.
 * It cannot read scanned/image-only PDFs (those need OCR) and it may
 * mangle documents that use unusual font encodings - which is why the
 * importer always shows a preview before anything is saved.
 */

const zlib = require('node:zlib');

function inflateStreams(buffer) {
  const chunks = [];
  const streamToken = Buffer.from('stream');
  const endToken = Buffer.from('endstream');

  let position = 0;
  while (position < buffer.length) {
    const start = buffer.indexOf(streamToken, position);
    if (start === -1) break;
    const end = buffer.indexOf(endToken, start);
    if (end === -1) break;

    // Look back at the stream dictionary to see how it is encoded.
    const dictionaryStart = Math.max(0, start - 600);
    const dictionary = buffer.slice(dictionaryStart, start).toString('latin1');

    let dataStart = start + streamToken.length;
    if (buffer[dataStart] === 0x0d) dataStart++;
    if (buffer[dataStart] === 0x0a) dataStart++;

    let data = buffer.slice(dataStart, end);

    if (/\/FlateDecode/.test(dictionary)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.inflateRawSync(data);
        } catch {
          position = end + endToken.length;
          continue;
        }
      }
    } else if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode|LZWDecode)/.test(dictionary)) {
      position = end + endToken.length;
      continue;
    }

    chunks.push(data.toString('latin1'));
    position = end + endToken.length;
  }

  return chunks;
}

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== '\\') { out += char; continue; }

    const next = raw[++i];
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '(': out += '('; break;
      case ')': out += ')'; break;
      case '\\': out += '\\'; break;
      case '\n': break;              // line continuation
      case '\r': if (raw[i + 1] === '\n') i++; break;
      default:
        if (next >= '0' && next <= '7') {
          let octal = next;
          while (octal.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') octal += raw[++i];
          out += String.fromCharCode(parseInt(octal, 8));
        } else {
          out += next ?? '';
        }
    }
  }
  return out;
}

/** Pull the literal strings out of one content stream, preserving line breaks. */
function extractTextFromContent(content) {
  let out = '';
  const operatorPattern = /(\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|<[0-9A-Fa-f\s]*>)\s*(Tj|TJ|'|")|\[((?:[^\][]|\\.)*)\]\s*TJ|(T\*|Td|TD|ET)/g;

  let match;
  while ((match = operatorPattern.exec(content)) !== null) {
    if (match[3] !== undefined) {
      // Array form: [(Hello) -250 (World)] TJ
      const parts = match[3].match(/\((?:[^()\\]|\\.)*\)/g) || [];
      let segment = '';
      for (const part of parts) segment += decodePdfString(part.slice(1, -1));
      out += segment;
      // Large negative kerning usually means a word gap.
      if (/-\s*\d{3,}/.test(match[3])) out += ' ';
    } else if (match[1] !== undefined) {
      const literal = match[1];
      if (literal.startsWith('(')) {
        out += decodePdfString(literal.slice(1, -1));
      } else {
        // Hex string form.
        const hex = literal.slice(1, -1).replace(/\s+/g, '');
        for (let i = 0; i + 1 < hex.length; i += 2) {
          out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
      }
      if (match[2] === "'" || match[2] === '"') out += '\n';
    } else if (match[4] !== undefined) {
      out += '\n';
    }
  }
  return out;
}

function extractPdfText(buffer) {
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('This does not look like a PDF file.');
  }

  const streams = inflateStreams(buffer);
  let text = '';
  for (const stream of streams) {
    if (!/(Tj|TJ)\b/.test(stream)) continue;
    text += extractTextFromContent(stream) + '\n';
  }

  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.replace(/\s/g, '').length < 20) {
    throw new Error(
      'No readable text was found in this PDF. It is probably a scan or an image-only ' +
      'file - open it, copy the text, and paste it into the "Paste text" tab instead.'
    );
  }

  return text;
}

module.exports = { extractPdfText };
