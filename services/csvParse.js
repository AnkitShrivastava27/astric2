// services/csvParse.js
// Small RFC-4180 CSV parser: quoted fields (with commas, quotes and line breaks inside), CRLF / LF / CR line
// endings, UTF-8 BOM, and automatic delimiter detection (comma, semicolon or tab — Excel in many countries
// exports semicolons). Returns an array of rows (arrays of strings); fully blank rows are dropped.
'use strict';

function detectDelimiter(text) {
  const firstLine = (text.split(/\r\n|\n|\r/, 1)[0]) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] > 0 ? best : ',';
}

function parseCsv(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => { row.push(field); field = ''; rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;           // a quote only opens a quoted field at its start
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else if (c === '\n') endRow();
    else field += c;
  }
  if (field !== '' || row.length) endRow();

  return rows
    .map((r) => r.map((v) => v.trim()))
    .filter((r) => r.some((v) => v !== ''));
}

// rows -> array of { headerKey: value } using the first row as headers.
function csvToObjects(input) {
  const rows = parseCsv(input);
  if (rows.length < 2) return { headers: rows[0] || [], records: [] };
  const headers = rows[0];
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] !== undefined ? r[i] : ''; });
    return o;
  });
  return { headers, records };
}

module.exports = { parseCsv, csvToObjects };
