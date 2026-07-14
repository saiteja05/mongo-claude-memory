// Cyrillic and Greek letters that are visually indistinguishable from a
// Latin letter in most fonts (the classic homoglyph/domain-squatting
// trick), keyed by code point rather than a literal glyph so the source
// stays unambiguous about exactly which characters are covered. Every pair
// maps exactly one character to exactly one character (never one to many),
// which is what makes foldConfusables length-preserving.
const CONFUSABLE_PAIRS: Array<[number, string]> = [
  // Cyrillic lowercase lookalikes
  [0x0430, "a"], // CYRILLIC SMALL LETTER A
  [0x0435, "e"], // CYRILLIC SMALL LETTER IE
  [0x043e, "o"], // CYRILLIC SMALL LETTER O
  [0x0440, "p"], // CYRILLIC SMALL LETTER ER
  [0x0441, "c"], // CYRILLIC SMALL LETTER ES
  [0x0443, "y"], // CYRILLIC SMALL LETTER U
  [0x0445, "x"], // CYRILLIC SMALL LETTER HA
  [0x0456, "i"], // CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  [0x0455, "s"], // CYRILLIC SMALL LETTER DZE
  [0x0458, "j"], // CYRILLIC SMALL LETTER JE
  // Cyrillic uppercase lookalikes
  [0x0410, "A"], // CYRILLIC CAPITAL LETTER A
  [0x0415, "E"], // CYRILLIC CAPITAL LETTER IE
  [0x041e, "O"], // CYRILLIC CAPITAL LETTER O
  [0x0420, "P"], // CYRILLIC CAPITAL LETTER ER
  [0x0421, "C"], // CYRILLIC CAPITAL LETTER ES
  [0x0423, "Y"], // CYRILLIC CAPITAL LETTER U
  [0x0425, "X"], // CYRILLIC CAPITAL LETTER HA
  [0x0406, "I"], // CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I
  [0x0405, "S"], // CYRILLIC CAPITAL LETTER DZE
  [0x0408, "J"], // CYRILLIC CAPITAL LETTER JE
  // Greek lowercase lookalikes
  [0x03bf, "o"], // GREEK SMALL LETTER OMICRON
  [0x03bd, "v"], // GREEK SMALL LETTER NU
  [0x03b1, "a"], // GREEK SMALL LETTER ALPHA
  [0x03b5, "e"], // GREEK SMALL LETTER EPSILON
  [0x03b9, "i"], // GREEK SMALL LETTER IOTA
  [0x03c1, "p"], // GREEK SMALL LETTER RHO
  [0x03c5, "y"], // GREEK SMALL LETTER UPSILON
  [0x03ba, "k"], // GREEK SMALL LETTER KAPPA
  // Greek uppercase lookalikes
  [0x039f, "O"], // GREEK CAPITAL LETTER OMICRON
  [0x0391, "A"], // GREEK CAPITAL LETTER ALPHA
  [0x0395, "E"], // GREEK CAPITAL LETTER EPSILON
  [0x0399, "I"], // GREEK CAPITAL LETTER IOTA
  [0x03a1, "P"], // GREEK CAPITAL LETTER RHO
  [0x03a5, "Y"], // GREEK CAPITAL LETTER UPSILON
  [0x039a, "K"], // GREEK CAPITAL LETTER KAPPA
];

const CONFUSABLE_MAP: Record<string, string> = Object.fromEntries(
  CONFUSABLE_PAIRS.map(([codePoint, latin]) => [String.fromCharCode(codePoint), latin])
);

/**
 * Folds Cyrillic/Greek homoglyphs to the Latin letter they impersonate, one
 * character at a time. Guaranteed length-preserving (output.length ===
 * input.length): callers that find a match against the folded copy can
 * apply the same start/end indices to the original, un-folded text.
 */
export function foldConfusables(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    result += CONFUSABLE_MAP[ch] ?? ch;
  }
  return result;
}

// Zero-width/invisible unicode characters that can be inserted inside a word
// to defeat literal-phrase regex matching without changing how the text
// looks or reads to a human or an LLM: zero-width space, zero-width
// non-joiner, zero-width joiner, BOM/zero-width no-break space, and soft
// hyphen. Built from code points, like CONFUSABLE_PAIRS above, so the source
// never needs to embed an actual invisible character.
const INVISIBLE_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad];
const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_CODEPOINTS.map((codePoint) => String.fromCharCode(codePoint)).join("")}]`,
  "g"
);

/**
 * Normalizes text for boolean deny-list/keyword matching only: never for the
 * length or code-fence checks (which must keep seeing the original text),
 * and never in a context that needs to map a match position back to the
 * original text, since this does not preserve length. Folds homoglyphs,
 * applies Unicode NFKC normalization (catching other lookalike forms, e.g.
 * fullwidth Latin letters), strips invisible characters, then collapses any
 * run of whitespace, including newlines, into a single space.
 */
export function normalizeForMatching(text: string): string {
  return foldConfusables(text).normalize("NFKC").replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ");
}
