/**
 * Test fixtures for material processing.
 *
 * TEST DATA — all of it invented. No real student documents, nothing personal,
 * nothing copyrighted (§23). The prose is deliberately dull secondary-school
 * biology and physics, written for this file.
 *
 * Everything is generated rather than committed as a binary, and everything is
 * small: the largest fixture below is a few kilobytes, and the one oversized case
 * is built at call time from a repeated byte rather than stored.
 *
 * Fixtures are FUNCTIONS or frozen constants, so a test cannot mutate a buffer
 * another test then reads. `node --test` runs files in separate processes but
 * tests within a file share this module.
 */

import { makePdf } from "./make-pdf.mjs";

/**
 * A paragraph of ~380 characters, so a handful of them crosses the 1800-character
 * chunk size and forces the chunker to make a real boundary decision.
 */
const PARAGRAPH = [
  "Photosynthesis is the process by which green plants convert light energy into",
  "chemical energy stored as glucose. It takes place in the chloroplasts, where",
  "chlorophyll absorbs light most strongly in the blue and red parts of the",
  "spectrum. The light-dependent reactions split water and release oxygen, while",
  "the Calvin cycle fixes carbon dioxide into three-carbon sugars.",
].join(" ");

/** A short, entirely legitimate document. One chunk, no boundary search. */
export const SHORT_TXT = Object.freeze({
  filename: "exam-note.txt",
  type: "text/plain",
  content: "Biology exam: Friday, 9am. Revise photosynthesis and respiration.",
});

/**
 * A multi-paragraph text document that produces several chunks.
 *
 * Six paragraphs at ~380 characters each is ~2300 characters — over CHUNK_SIZE,
 * so this exercises the overlap and the paragraph-boundary snap rather than just
 * the single-chunk path.
 */
export const MULTI_CHUNK_TXT = Object.freeze({
  filename: "photosynthesis.txt",
  type: "text/plain",
  content: Array.from(
    { length: 6 },
    (_, index) => `Section ${index + 1}. ${PARAGRAPH}`,
  ).join("\n\n"),
});

// ── the normalization fixture ────────────────────────────────────────────────
//
// Every invisible character below is written as a \u{…} escape rather than pasted
// literally, for the reason src/materials/text-normalizer.js gives at length: a
// NUL, an NBSP or a zero-width space in a source file is invisible in review,
// impossible to verify in a diff, and liable to be rewritten by any tool that
// touches whitespace. Naming the code points is the only form a reader can check.

const BOM = "\u{FEFF}";
const NBSP = "\u{00A0}";
const ZWSP = "\u{200B}";
const NUL = "\u{0000}";
const LINE_SEPARATOR = "\u{2028}";

/**
 * A document containing every normalization case, for asserting §15's rules
 * end-to-end rather than only in the normalizer's unit tests.
 */
export const MESSY_TXT = Object.freeze({
  filename: "messy-notes.txt",
  type: "text/plain",
  content:
    // BOM, as a Windows editor writes it; leading spaces; CRLF.
    `${BOM}  Cell Biology\r\n` +
    // A run of blank lines, to be collapsed to exactly one.
    "\r\n\r\n\r\n" +
    // Two NBSPs to fold to one plain space, a tab run to collapse, trailing
    // spaces to strip.
    `Mitochondria${NBSP}${NBSP}produce ATP.\t\tThey have their own DNA.   \r\n` +
    // A zero-width space to remove, a NUL to remove, then a lone CR.
    `The${ZWSP}nucleus stores${NUL} genetic information.\r` +
    // U+2028, which becomes a newline.
    `Ribosomes assemble proteins.${LINE_SEPARATOR}` +
    // Subscripts, which must SURVIVE: NFKC would rewrite them to plain digits and
    // turn H₂O into H2O. Asserted in the tests, not assumed.
    "Water is H₂O and glucose is C₆H₁₂O₆.\n" +
    "   \n",
});

/**
 * What MESSY_TXT must normalize to, exactly.
 *
 * Written out in full rather than computed. A test comparing
 * `normalizeText(input)` against an expectation built by calling the same
 * normalizer would pass regardless of what either did; this is the independent
 * statement of the result. Every difference from the input is one of §15's nine
 * documented steps.
 */
export const MESSY_TXT_NORMALIZED = [
  "Cell Biology",
  "",
  "Mitochondria produce ATP. They have their own DNA.",
  "Thenucleus stores genetic information.",
  "Ribosomes assemble proteins.",
  "Water is H₂O and glucose is C₆H₁₂O₆.",
].join("\n");

/** Valid file, no readable content: §17's case. Whitespace only. */
export const EMPTY_TXT = Object.freeze({
  filename: "blank.txt",
  type: "text/plain",
  content: "   \n\n\t\r\n   \n",
});

/** Zero bytes — rejected at validation, before a material row exists. */
export const ZERO_BYTE_TXT = Object.freeze({
  filename: "nothing.txt",
  type: "text/plain",
  content: "",
});

/**
 * A three-page PDF whose pages have distinguishable text.
 *
 * Each page names its own number, so a test can assert that a chunk's
 * `page_number` matches the page its content came from — the property that makes
 * §13's page attribution meaningful rather than merely present.
 */
export function multiPagePdf() {
  return {
    filename: "cell-biology.pdf",
    type: "application/pdf",
    content: makePdf([
      [
        "Cell Biology: Page One",
        "The cell is the basic unit of life.",
        "Prokaryotes have no nucleus; eukaryotes do.",
      ],
      [
        "Cell Biology: Page Two",
        "Mitochondria generate ATP by oxidative phosphorylation.",
        "Chloroplasts carry out photosynthesis in plant cells.",
      ],
      [
        "Cell Biology: Page Three",
        "The cell membrane is a phospholipid bilayer.",
        "Diffusion moves substances down a concentration gradient.",
      ],
    ]),
  };
}

/**
 * A one-page PDF long enough to produce more than one chunk.
 *
 * 40 lines of ~70 characters is ~2800 characters on a single page, so per-page
 * chunking produces multiple chunks that must ALL carry page_number 1. A PDF
 * whose every page fits in one chunk could not tell a correct implementation from
 * one that numbered chunks instead of pages.
 */
export function longSinglePagePdf() {
  return {
    filename: "thermodynamics.pdf",
    type: "application/pdf",
    content: makePdf([
      Array.from(
        { length: 40 },
        (_, index) =>
          `Line ${String(index + 1).padStart(2, "0")}: energy is conserved in an isolated system.`,
      ),
    ]),
  };
}

/**
 * A file that passes validation as a PDF but that pdfjs cannot parse: correct
 * `%PDF-` signature, nonsense after it.
 *
 * This is the fixture for §22's "malformed PDF fails safely". It has to pass the
 * signature check to be interesting — a file that fails validation never reaches
 * the parser, so it would test the wrong boundary.
 */
export const MALFORMED_PDF = Object.freeze({
  filename: "corrupt.pdf",
  type: "application/pdf",
  content: "%PDF-1.4\n%%EOF\nthis is not a pdf body at all\n",
});

/**
 * A PDF that parses but yields no text: one page, no text operators.
 *
 * The stand-in for a scanned document. A real scan is a page-sized image with no
 * text layer, and embedding an image would make the fixture large for no gain;
 * what matters to the pipeline is identical — pdfjs parses it, returns pages, and
 * the text is empty. §17 requires this to fail rather than become an empty
 * `ready` material.
 */
export function textlessPdf() {
  return {
    filename: "scanned.pdf",
    type: "application/pdf",
    content: makePdf([[]]),
  };
}

/** A PNG's magic bytes with a .txt name — an extension/content mismatch. */
export const PNG_NAMED_TXT = Object.freeze({
  filename: "sneaky.txt",
  type: "text/plain",
  content: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]),
});

/** Plain text with a .pdf name — the same mismatch the other way round. */
export const TXT_NAMED_PDF = Object.freeze({
  filename: "not-really.pdf",
  type: "application/pdf",
  content: "This is plain text pretending to be a PDF document.",
});

/** An extension the API does not accept at all. */
export const UNSUPPORTED_EXTENSION = Object.freeze({
  filename: "notes.docx",
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  content: "irrelevant",
});

/**
 * A file over the upload limit.
 *
 * Built on demand from a repeated byte rather than committed: 11 MB of anything
 * has no business in a repository, and `Buffer.alloc` produces it in
 * microseconds.
 *
 * @param {number} bytes
 */
export function oversizedTxt(bytes) {
  return {
    filename: "huge.txt",
    type: "text/plain",
    // 0x41 = "A". A repeated printable byte, so if this ever does reach
    // extraction the failure is legible rather than binary noise.
    content: Buffer.alloc(bytes, 0x41),
  };
}

/**
 * Build a multipart body for POST /api/materials.
 *
 * Mirrors `askForm` in tests/helpers/server-harness.mjs, deliberately as a
 * separate function: that one builds /api/ask's fields (username, question,
 * file) and this one builds this endpoint's (username, file). Sharing it would
 * couple the two endpoints' request shapes in the tests, and §19 requires
 * /api/ask's to stay exactly as it is.
 *
 * Every part is optional so a test can send a body that is missing one.
 *
 * @param {object} input
 * @param {string} [input.username]
 * @param {{filename: string, type: string, content: string|Buffer}} [input.file]
 * @param {Array<{filename: string, type: string, content: string|Buffer}>} [input.files]
 *   more than one file part, for the "exactly one file" rejection
 * @returns {FormData}
 */
export function materialForm({ username, file, files }) {
  const form = new FormData();
  if (username !== undefined) form.append("username", username);

  for (const entry of files ?? (file ? [file] : [])) {
    form.append(
      "file",
      new Blob([entry.content], { type: entry.type }),
      entry.filename,
    );
  }
  return form;
}
