/**
 * Text normalization — deterministic, lossless where it matters.
 *
 * Sits between extraction and chunking. Its whole job is to make text from two
 * different sources comparable, so that a chunk boundary depends on the
 * document's content and not on whether it was written on Windows or which PDF
 * producer emitted it.
 *
 * THE EXACT BEHAVIOUR, in order (§15 asks for this documented precisely; the
 * same list appears in docs/material-processing.md):
 *
 *   1. Unicode line separators U+2028 / U+2029 -> "\n"
 *   2. CRLF ("\r\n") and lone CR ("\r") -> "\n"
 *   3. NUL bytes and C0/C1 control characters removed, EXCEPT "\n" and "\t"
 *   4. Zero-width characters and the BOM removed (U+FEFF, U+200B-U+200D, U+2060)
 *   5. Non-breaking and exotic spaces -> a plain space (U+00A0, U+1680,
 *      U+2000-U+200A, U+202F, U+205F, U+3000)
 *   6. Runs of spaces/tabs collapsed to one space
 *   7. Trailing spaces/tabs removed from the end of every line
 *   8. Three or more consecutive newlines collapsed to exactly two
 *   9. Leading and trailing whitespace removed from the whole document
 *
 * Every character class below is built by codePointClass() from numeric code
 * points rather than written as a regex literal containing the characters
 * themselves. These are by definition invisible or control characters: pasted
 * literally they make this file unreadable, unreviewable in a diff, and liable to
 * be mangled by any tool that touches whitespace. Naming the code points is the
 * only form in which a reader can check the list against the comment.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No summarizing, no paraphrasing, no rewriting, no spell-checking, no case
 * folding, no stop-word removal, no de-hyphenation across line breaks, no LLM,
 * no Unicode NFC/NFKC normalization. The output is the user's own words with the
 * formatting noise removed — §15's "retrieval-ready source text, not
 * summarization".
 *
 * Two of those omissions are worth their reasons:
 *
 *   • **NFKC is not applied.** It would fold the ligature "fi" to "fi" and "½"
 *     to "1/2", which reads like a tidy-up until it reaches mathematics: NFKC
 *     rewrites a superscript two as a plain 2, turning x-squared into x2. A study
 *     document is exactly the kind of text where that matters, so the code points
 *     are left alone.
 *   • **Single newlines are preserved.** Collapsing them into spaces would read
 *     better as prose and would destroy every line-structured document — poetry,
 *     code samples, tables, numbered lists. Step 8 removes blank-line *runs*
 *     while leaving paragraph boundaries (one blank line) intact, which is the
 *     distinction §15 asks for.
 *
 * Deterministic and pure: same input, same output, no clock, no randomness, no
 * configuration, no I/O. That is what makes the chunker's tests meaningful.
 */

/**
 * Build a global character-class RegExp from code points and ranges.
 *
 * @param {Array<number|[number, number]>} parts single code points, or
 *   inclusive [start, end] ranges
 * @returns {RegExp}
 */
function codePointClass(parts) {
  const body = parts
    .map((part) =>
      Array.isArray(part)
        ? `${escapeCodePoint(part[0])}-${escapeCodePoint(part[1])}`
        : escapeCodePoint(part),
    )
    .join("");
  return new RegExp(`[${body}]`, "gu");
}

/** A code point as a regex-safe "\uXXXX" escape. */
function escapeCodePoint(code) {
  return `\\u{${code.toString(16).toUpperCase()}}`;
}

/**
 * C0 and C1 control characters, except newline (U+000A) and tab (U+0009).
 *
 * The exceptions are the interesting part, which is why the ranges are spelled
 * out rather than expressed as \p{Cc} minus a set. U+000B (vertical tab) and
 * U+000C (form feed) ARE removed: PDF extractors emit them as layout artefacts
 * and neither carries meaning in extracted text. U+0000 (NUL) falls in the first
 * range, which is §15's "remove null bytes".
 */
const CONTROL_CHARACTERS = codePointClass([
  [0x00, 0x08], // NUL through BS — U+0009 TAB is kept
  [0x0b, 0x0c], // VT, FF — U+000A LF is kept
  [0x0e, 0x1f], // SO through US — U+000D CR is already gone by step 2
  [0x7f, 0x9f], // DEL and the C1 block
]);

/**
 * Zero-width characters and the byte-order mark.
 *
 * Invisible, and they break substring matching for anything that later searches
 * this text: a chunk containing "photo<ZWSP>synthesis" does not match a query
 * for "photosynthesis" while looking identical to it on screen.
 */
const INVISIBLE_CHARACTERS = codePointClass([
  0xfeff, // BOM / zero-width no-break space
  [0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ
  0x2060, // word joiner
]);

/**
 * Spaces that are not U+0020.
 *
 * NBSP (U+00A0) is the common one — PDF extraction produces it constantly, and it
 * is invisible in a diff while being a different character to every string
 * comparison. The rest are the Unicode space separators a word processor can
 * emit. U+200B is NOT here: it is zero-width, so it is removed above rather than
 * turned into a space that was never in the document.
 */
const EXOTIC_SPACES = codePointClass([
  0x00a0, // NBSP
  0x1680, // Ogham space mark
  [0x2000, 0x200a], // en quad through hair space
  0x202f, // narrow NBSP
  0x205f, // medium mathematical space
  0x3000, // ideographic space
]);

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. */
const UNICODE_LINE_SEPARATORS = codePointClass([[0x2028, 0x2029]]);

/**
 * Normalize extracted text.
 *
 * @param {string} raw text straight from an extractor
 * @returns {string} normalized text; "" if the input held nothing meaningful
 */
export function normalizeText(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";

  return (
    raw
      // 1. Unicode line/paragraph separators. Before the CR pass, so everything
      //    downstream deals in "\n" only.
      .replace(UNICODE_LINE_SEPARATORS, "\n")
      // 2. Line endings. `\r\n?` takes the longest match first, so CRLF becomes
      //    one newline rather than two — replacing lone CR first would invent a
      //    paragraph break in every Windows document.
      .replace(/\r\n?/g, "\n")
      // 3. Control characters, newline and tab excepted.
      .replace(CONTROL_CHARACTERS, "")
      // 4. Invisible characters.
      .replace(INVISIBLE_CHARACTERS, "")
      // 5. Exotic spaces -> plain space.
      .replace(EXOTIC_SPACES, " ")
      // 6. Collapse horizontal whitespace runs. PDF extraction pads columns with
      //    long space runs that carry no information and would otherwise eat a
      //    large fraction of every chunk's character budget.
      .replace(/[ \t]{2,}/g, " ")
      // 7. Strip trailing horizontal whitespace per line, so a "blank" line with
      //    two spaces on it counts as blank in step 8.
      .replace(/[ \t]+$/gm, "")
      // 8. At most one blank line between blocks. Preserves the paragraph
      //    boundary; removes the multi-line gaps page breaks produce.
      .replace(/\n{3,}/g, "\n\n")
      // 9. Whole-document trim — §15's "remove obviously empty leading and
      //    trailing sections". Also removes leading whitespace on the first line,
      //    which the per-line pass in step 7 leaves behind.
      .trim()
  );
}

/**
 * Whether normalized text is worth storing.
 *
 * A file can be perfectly valid, parse without error, and still contain nothing
 * a reader could use — a PDF of a blank scanned page, a .txt of newlines, a
 * document whose only content was a control character. §17 requires those to
 * fail rather than become an empty `ready` material, and this is the predicate
 * that decides it.
 *
 * The threshold is "any non-whitespace character at all", not a word count or a
 * minimum length. A one-line note ("Exam: Friday") is a legitimate document, and
 * a heuristic that rejected it would be guessing at the user's intent. The
 * chunker enforces its own non-empty rule per chunk on top of this.
 *
 * @param {string} normalized output of normalizeText()
 * @returns {boolean}
 */
export function hasMeaningfulText(normalized) {
  return typeof normalized === "string" && normalized.trim().length > 0;
}
