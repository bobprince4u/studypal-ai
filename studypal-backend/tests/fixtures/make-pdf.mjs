/**
 * A minimal PDF writer, for test fixtures only.
 *
 * TEST DATA. Nothing here is imported by src/.
 *
 * WHY THIS EXISTS RATHER THAN A COMMITTED .pdf FILE
 * -------------------------------------------------
 * §23 asks for a small multi-page PDF fixture and forbids committing large or
 * real documents. A generated one is better than a checked-in binary on every
 * axis that matters here: a reviewer can read what is in it, the page text is
 * visible in the diff when it changes, and a test asserting "page 2 contains X"
 * sits next to the code that put X on page 2. A binary blob would make all three
 * opaque.
 *
 * It also avoids a dependency. Every PDF-generating library (pdfkit, pdf-lib) is
 * megabytes of code to produce a document with two lines of text on it, and §30
 * is explicit about not adding infrastructure this iteration does not need.
 *
 * WHAT IT SUPPORTS
 * ----------------
 * Uncompressed page content streams with one text-showing operator per line, in
 * one built-in font. No compression, no images, no fonts to embed, no
 * cross-reference streams, no encryption. That is the smallest subset of PDF 1.4
 * that pdfjs will parse and extract text from, and the extraction path is the
 * only thing under test.
 *
 * The output is byte-for-byte deterministic: no timestamps, no ids, no random
 * padding. Two calls with the same pages produce identical buffers, which is what
 * lets a test assert that chunking a PDF is reproducible.
 */

/**
 * Escape a string for a PDF literal string, `( … )`.
 *
 * The three characters that must be escaped are `\`, `(` and `)` — an unbalanced
 * parenthesis inside a literal string ends it early and corrupts the file.
 * Backslash goes first, or it would double the escapes added after it.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeLiteral(text) {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

/**
 * A page's content stream: lines of text, top to bottom.
 *
 * BT/ET delimit a text object. `Tf` selects the font and size, `Td` sets the
 * position in points from the bottom-left corner, and `Tj` shows a string. Lines
 * step down by 16 points from y=760, which fits ~46 lines on a 792-point page —
 * more than any fixture needs.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function contentStream(lines) {
  const shown = lines
    .map((line, index) => {
      const y = 760 - index * 16;
      return `BT /F1 12 Tf 72 ${y} Td (${escapeLiteral(line)}) Tj ET`;
    })
    .join("\n");
  return `${shown}\n`;
}

/**
 * Build a PDF from per-page text.
 *
 * The object graph is the minimum a viewer requires:
 *
 *   1        Catalog        → Pages
 *   2        Pages          → each Page
 *   3        Font           Helvetica, one of the 14 built-ins, so nothing is
 *                           embedded and no font file is needed
 *   4, 5, …  Page + Contents, two objects per page
 *
 * Offsets in the cross-reference table are byte positions from the start of the
 * file, so the body is assembled first and measured as it goes — hence the
 * running `offsets` array rather than a second pass.
 *
 * @param {Array<string[]>} pages one array of lines per page
 * @returns {Buffer}
 */
export function makePdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("makePdf needs at least one page");
  }

  // Page and content objects start at 4; two objects per page.
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const objects = [];

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} ` +
    `/Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  pages.forEach((lines, index) => {
    const pageId = pageObjectIds[index];
    const contentsId = pageId + 1;
    const stream = contentStream(lines);

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R ` +
      // US Letter in points. Any size would do; a real one keeps the fixture
      // recognisable as a document if anyone opens it.
      `/MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${contentsId} 0 R >>`;

    // /Length must be the stream's byte count, and the text is ASCII here so
    // character count equals byte count. Buffer.byteLength is used anyway rather
    // than .length — the day a fixture contains a non-ASCII character, a wrong
    // /Length would produce a truncated stream and a mystifying parse failure.
    objects[contentsId] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
  });

  // ── assemble ──────────────────────────────────────────────────────────────
  // %PDF-1.4 is the version header pdfjs and every other parser accepts, and
  // `%PDF-` is also the magic signature src/materials/file-validation.js checks.
  let body = "%PDF-1.4\n";
  const offsets = [];

  for (let id = 1; id < objects.length; id++) {
    if (objects[id] === undefined) continue;
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "latin1");
  const highestId = objects.length - 1;

  // The cross-reference table. Every entry is EXACTLY 20 bytes — ten digits, a
  // space, five digits, a space, `n` or `f`, then two more bytes of line ending.
  // Parsers index into this table arithmetically, so a single missing space
  // shifts every subsequent lookup. The free-list head (object 0) is mandatory.
  let xref = `xref\n0 ${highestId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= highestId; id++) {
    xref +=
      offsets[id] === undefined
        ? "0000000000 65535 f \n"
        : `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }

  // No /ID and no /Info: both are optional, and an /ID would either be random —
  // breaking byte-for-byte determinism — or a fixed lie.
  const trailer =
    `trailer\n<< /Size ${highestId + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  // latin1 throughout: it maps each byte to one code unit, so the offsets
  // computed above are the offsets in the buffer. Writing this as utf8 would
  // silently shift every offset after the first multi-byte character.
  return Buffer.from(body + xref + trailer, "latin1");
}
