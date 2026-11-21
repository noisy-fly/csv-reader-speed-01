// Fast drop-in for csv-reader 1.0.0: same answers, faster scan.
//
// Strategy: one left-to-right pass, but fields are taken with native
// regex scans to the next delimiter and String.slice instead of
// character-by-character concatenation. Broken-row cases (stray CR,
// quote junk, unterminated quotes) are rare, so they take a slow path
// while the common unquoted / cleanly quoted fields stay on the fast one.
//
// Semantics (mirroring the reference policy):
// - U+FEFF at the very start is dropped; empty lines are no records.
// - A record ends at LF or CRLF; a CR outside quotes not followed by LF
//   is dropped (error stray_cr).
// - A field opening with a quote runs to the next non-doubled quote;
//   "" inside is one quote; CRLF / lone CR inside read as LF. Text
//   after the closing quote up to the next comma or line break is
//   appended as-is (error quote_junk if anything was appended). A quote
//   that never closes is a literal character and the text after it is
//   re-read as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is literal; fields stay strings.
// - columns is the first record when header is true, else null; rows are
//   padded (short_row, with fields: count) or cut (long_row, with extra:
//   the cut fields) to the first record's width.
// - Each error is {code, line, row}; line is the 1-based line its record
//   starts on, row its index in rows (null for the header), in the order
//   met; a record's short_row / long_row is recorded when it ends.

const DELIM = /[,\r\n]/g; // next comma / CR / LF for an unquoted field
const QDELIM = /["\r\n]/g; // next quote / CR / LF inside a quoted field

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while the header is being read).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break. Returns {value, ended, added}: `added` counts the characters
  // kept, so a caller can tell whether quote junk followed a closing
  // quote. A CR not followed by LF is dropped (stray_cr) and scanning
  // continues in the same field.
  function readUnquoted(value) {
    const startLen = value.length;
    while (true) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) value += text.slice(pos);
        pos = n;
        return { value, ended: END, added: value.length - startLen };
      }
      const at = m.index;
      const c = m[0];
      if (c === ',') {
        if (at > pos) value += text.slice(pos, at);
        pos = at + 1;
        return { value, ended: COMMA, added: value.length - startLen };
      }
      if (c === '\n') {
        if (at > pos) value += text.slice(pos, at);
        pos = at + 1;
        line += 1;
        return { value, ended: BREAK, added: value.length - startLen };
      }
      // c === '\r'
      if (text.charCodeAt(at + 1) === 10) {
        if (at > pos) value += text.slice(pos, at);
        pos = at + 2;
        line += 1;
        return { value, ended: BREAK, added: value.length - startLen };
      }
      error('stray_cr');
      if (at > pos) value += text.slice(pos, at);
      pos = at + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let seg = pos; // start of the not-yet-appended segment
    let closed = false;
    while (pos < n) {
      QDELIM.lastIndex = pos;
      const m = QDELIM.exec(text);
      if (m === null) break;
      const at = m.index;
      const c = m[0];
      if (c === '"') {
        if (text.charCodeAt(at + 1) === 34) {
          // Doubled quote: one literal quote, keep scanning.
          value += text.slice(seg, at) + '"';
          pos = at + 2;
          seg = pos;
          continue;
        }
        value += text.slice(seg, at);
        pos = at + 1;
        closed = true;
        break;
      }
      // '\n' or '\r' inside quotes: one LF in the value, one line.
      value += text.slice(seg, at) + '\n';
      line += 1;
      pos = at + 1 + (c === '\r' && text.charCodeAt(at + 1) === 10 ? 1 : 0);
      seg = pos;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
