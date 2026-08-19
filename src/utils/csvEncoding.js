/**
 * Decode CSV upload bytes with encoding detection.
 *
 * Excel / regional exports are often Windows-1250 / 1252 / 1257, not UTF-8.
 * Apollo / older DOS tools sometimes export IBM850 (CP850), where ü is byte 0x81.
 * Reading those as Windows-1252 stores U+0081 ("Grnder" instead of "Gründer").
 */

const LATIN_CANDIDATE_ENCODINGS = [
  'windows-1250', // Central Europe — š ž č ť (common for EE/CZ/PL/SK/HU CSVs)
  'windows-1257', // Baltic
  'windows-1252', // Western Europe
  'iso-8859-2',
  'iso-8859-1',
  'latin1',
];

/** IBM850 (CP850) high bytes 0x80–0xFF. */
const IBM850_HIGH_CODES = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00f8, 0x00a3, 0x00d8, 0x00d7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x00ae, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00c1, 0x00c2, 0x00c0, 0x00a9, 0x2563, 0x2551, 0x2557, 0x255d, 0x00a2, 0x00a5, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x00e3, 0x00c3, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x00a4,
  0x00f0, 0x00d0, 0x00ca, 0x00cb, 0x00c8, 0x0131, 0x00cd, 0x00ce, 0x00cf, 0x2518, 0x250c, 0x2588, 0x2584, 0x00a6, 0x00cc, 0x2580,
  0x00d3, 0x00df, 0x00d4, 0x00d2, 0x00f5, 0x00d5, 0x00b5, 0x00fe, 0x00de, 0x00da, 0x00db, 0x00d9, 0x00fd, 0x00dd, 0x00af, 0x00b4,
  0x00ad, 0x00b1, 0x2017, 0x00be, 0x00b6, 0x00a7, 0x00f7, 0x00b8, 0x00b0, 0x00a8, 0x00b7, 0x00b9, 0x00b3, 0x00b2, 0x25a0, 0x00a0,
];

function stripBom(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return { buffer: buffer.subarray(3), bom: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { buffer: buffer.subarray(2), bom: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { buffer: buffer.subarray(2), bom: 'utf-16be' };
  }
  return { buffer, bom: null };
}

function decodeIbm850(buffer) {
  let out = '';
  for (let i = 0; i < buffer.length; i += 1) {
    const b = buffer[i];
    out += b < 0x80 ? String.fromCharCode(b) : String.fromCharCode(IBM850_HIGH_CODES[b - 0x80]);
  }
  return out;
}

function scoreDecodedText(text) {
  let score = 0;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  score -= replacement * 1000;

  // C1 controls often mean "decoded with wrong Western encoding" (e.g. 0x81 → U+0081)
  const c1 = (text.match(/[\u0080-\u009F]/g) || []).length;
  score -= c1 * 80;

  // Box drawing / blocks: common if CP850 is applied to the wrong file
  const boxes = (text.match(/[\u2500-\u259F\u25A0]/g) || []).length;
  score -= boxes * 20;

  // Prefer real Latin Extended letters (š ž č ť …)
  const latinExt = (text.match(/[\u0100-\u024F]/g) || []).length;
  score += latinExt * 8;

  // Western letters including umlauts (ü ä ö ß é …)
  const latin1Letters = (text.match(/[\u00C0-\u00FF]/g) || []).length;
  score += latin1Letters * 6;

  const umlauts = (text.match(/[äöüÄÖÜß]/g) || []).length;
  score += umlauts * 25;

  score += Math.min(text.length, 5000) * 0.001;
  return score;
}

function tryDecode(buffer, encoding, { fatal = false } = {}) {
  try {
    return new TextDecoder(encoding, { fatal }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * Map leftover C1 controls as IBM850 letters (ü ä ö …).
 * Safe for stored names that were imported with the wrong 8-bit encoding.
 */
export function repairC1AsIbm850(value) {
  if (value == null) return value;
  const s = String(value);
  if (!/[\u0080-\u009F]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x80 && code <= 0x9f) {
      out += String.fromCharCode(IBM850_HIGH_CODES[code - 0x80]);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Repair CP850 text that was stored as Windows-1252 punctuation
 * (ä→„, ö→”, é→‚, Ö→™) when those marks sit between letters.
 */
export function repairWin1252OemPunctuation(value) {
  if (value == null) return value;
  let s = String(value);
  if (!/[„”‚™]/.test(s)) return s;
  s = s.replace(/(\p{L})„(\p{L})/gu, '$1ä$2');
  s = s.replace(/(\p{L})”(\p{L})/gu, '$1ö$2');
  s = s.replace(/(\p{L})‚(\p{L})/gu, '$1é$2');
  s = s.replace(/(\p{L})™(\p{L})/gu, '$1Ö$2');
  s = s.replace(/(\p{L})„(?=\s|[)\].,;:/-]|$)/gu, '$1ä');
  s = s.replace(/(\p{L})‚(?=\s|[)\].,;:/-]|$)/gu, '$1é');
  return s;
}

/** Fill U+FFFD holes that came from German umlauts in titles/company names. */
export function repairGermanReplacementChars(value) {
  if (value == null) return value;
  let s = String(value);
  if (!/\uFFFD/.test(s)) return s;
  const pairs = [
    [/Gr\uFFFDnder/gi, 'Gründer'],
    [/Gesch\uFFFDfts/gi, 'Geschäfts'],
    [/f\uFFFDhrer/gi, 'führer'],
    [/f\uFFFDr\b/gi, 'für'],
    [/L\uFFFDsung/gi, 'Lösung'],
    [/beschr\uFFFDnkt/gi, 'beschränkt'],
    [/K\uFFFDnig/gi, 'König'],
    [/M\uFFFDnch/gi, 'Münch'],
    [/Z\uFFFDrich/gi, 'Zürich'],
    [/b\uFFFDro/gi, 'büro'],
    [/B\uFFFDro/g, 'Büro'],
    [/\uFFFDber/gi, 'über'],
    [/\uFFFDsterreich/gi, 'Österreich'],
    [/pr\uFFFDf/gi, 'prüf'],
    [/Pr\uFFFDf/g, 'Prüf'],
    [/r\uFFFDck/gi, 'rück'],
    [/k\uFFFDnnen/gi, 'können'],
    [/m\uFFFDssen/gi, 'müssen'],
    [/w\uFFFDrde/gi, 'würde'],
    [/n\uFFFDchst/gi, 'nächst'],
    [/Gr\uFFFDsse/gi, 'Grösse'],
    [/O\uFFFD\b/g, 'OÜ'],
    [/\bo\uFFFD\b/g, 'oü'],
  ];
  for (const [re, to] of pairs) s = s.replace(re, to);
  return s;
}

export function repairImportedText(value) {
  if (value == null) return value;
  return repairGermanReplacementChars(repairWin1252OemPunctuation(repairC1AsIbm850(value)));
}

/**
 * @param {Buffer} buffer
 * @returns {{ text: string, encoding: string }}
 */
export function decodeCsvBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  const { buffer: raw, bom } = stripBom(buffer);

  if (bom === 'utf-16le') {
    return { text: raw.toString('utf16le'), encoding: 'utf-16le' };
  }
  if (bom === 'utf-16be') {
    const text = tryDecode(raw, 'utf-16be');
    if (text != null) return { text, encoding: 'utf-16be' };
  }
  if (bom === 'utf-8') {
    return { text: repairImportedText(raw.toString('utf8')), encoding: 'utf-8' };
  }

  // Prefer strict UTF-8 when the file is valid UTF-8 (no replacement chars / C1 junk).
  const utf8Strict = tryDecode(raw, 'utf-8', { fatal: true });
  if (utf8Strict != null && !/[\u0080-\u009F]/.test(utf8Strict)) {
    return { text: utf8Strict, encoding: 'utf-8' };
  }

  const ibm850Text = decodeIbm850(raw);
  let best = { text: ibm850Text, encoding: 'ibm850', score: scoreDecodedText(ibm850Text) };

  for (const encoding of LATIN_CANDIDATE_ENCODINGS) {
    const text = tryDecode(raw, encoding);
    if (text == null) continue;
    const score = scoreDecodedText(text);
    if (score > best.score) {
      best = { text, encoding, score };
    }
  }

  if (utf8Strict != null) {
    const utf8Score = scoreDecodedText(utf8Strict);
    if (utf8Score > best.score) {
      best = { text: utf8Strict, encoding: 'utf-8', score: utf8Score };
    }
  }

  const repaired = repairImportedText(best.text);
  return { text: repaired, encoding: best.encoding };
}

/** True if a stored name still contains encoding-corruption markers. */
export function nameHasEncodingCorruption(value) {
  if (value == null) return false;
  const s = String(value);
  return /\uFFFD/.test(s) || /[\u0080-\u009F]/.test(s) || /[„”‚™]/.test(s);
}

/**
 * Prefer an incoming name when it repairs corruption in the existing value.
 * @returns {string|null} value to write, or null if no change
 */
export function preferRepairedName(existing, incoming) {
  const next = incoming == null ? null : String(incoming).trim();
  if (!next) return null;
  const prev = existing == null ? '' : String(existing).trim();
  if (!prev) return next;
  if (prev === next) return null;
  if (nameHasEncodingCorruption(prev) && !nameHasEncodingCorruption(next)) {
    return next;
  }
  return null;
}
