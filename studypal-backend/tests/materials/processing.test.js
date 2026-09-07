/**
 * Processing pipeline unit tests — §22's "Processing" group, minus the parts that
 * need a database.
 *
 * Four modules, tested directly rather than through HTTP:
 *
 *   file-validation.js    what a file IS, from extension + claim + content
 *   document-extractor.js bytes -> per-page text
 *   text-normalizer.js    §15's steps, exactly
 *   text-chunker.js       deterministic, ordered, terminating chunks
 *
 * All four are pure or near-pure — no database, no filesystem, no network — so
 * this suite needs no PostgreSQL and no server. The end-to-end behaviour they add
 * up to (status transitions, persisted chunks, page attribution) is asserted over
 * HTTP in the API suite; the point of testing the pieces here is that a failure
 * names which piece is wrong.
 *
 * Every invisible character below is written as a \u{…} escape rather than pasted
 * literally, for the reason src/materials/text-normalizer.js gives at length: a
 * NUL, an NBSP or a zero-width space in a source file is invisible in review,
 * impossible to verify in a diff, and liable to be rewritten by any tool that
 * touches whitespace. Naming the code points is the only form a reader can check.
 *
 *   node --test tests/materials/processing.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { config } from "../../src/config/env.js";
import {
  ExtractionError,
  extractDocument,
} from "../../src/materials/document-extractor.js";
import {
  ALLOWED_MATERIAL_EXTENSIONS,
  extensionOf,
  validateUpload,
} from "../../src/materials/file-validation.js";
import {
  hasMeaningfulText,
  normalizeText,
} from "../../src/materials/text-normalizer.js";
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  chunkPages,
  chunkText,
  chunkingConfig,
} from "../../src/materials/text-chunker.js";
import {
  EMPTY_TXT,
  MALFORMED_PDF,
  MESSY_TXT,
  MESSY_TXT_NORMALIZED,
  MULTI_CHUNK_TXT,
  PNG_NAMED_TXT,
  SHORT_TXT,
  TXT_NAMED_PDF,
  UNSUPPORTED_EXTENSION,
  ZERO_BYTE_TXT,
  longSinglePagePdf,
  multiPagePdf,
  textlessPdf,
} from "../fixtures/materials.mjs";

// ── the code points under test, named ──────────────────────────────────────
const BOM = "\u{FEFF}"; // ZERO WIDTH NO-BREAK SPACE, used as a byte-order mark
const NUL = "\u{0000}";
const VT = "\u{000B}"; // vertical tab
const FF = "\u{000C}"; // form feed
const LS = "\u{2028}"; // LINE SEPARATOR
const NEL = "\u{0085}"; // NEXT LINE
const ZWSP = "\u{200B}";
const ZWNJ = "\u{200C}";
const ZWJ = "\u{200D}";
const WJ = "\u{2060}"; // WORD JOINER
const NBSP = "\u{00A0}";
const THIN_SPACE = "\u{2009}";
const IDEOGRAPHIC_SPACE = "\u{3000}";

/** A fixture's content as a Buffer, whatever form it was written in. */
const bytes = (fixture) =>
  Buffer.isBuffer(fixture.content)
    ? fixture.content
    : Buffer.from(fixture.content, "utf8");

/** Run validateUpload over a fixture as the upload path would. */
const validate = (fixture, overrides = {}) =>
  validateUpload({
    filename: fixture.filename,
    clientMimeType: fixture.type,
    buffer: bytes(fixture),
    ...overrides,
  });

/**
 * A message a client may see must not carry internals.
 *
 * Used everywhere a message crosses the boundary. Absolute paths, stack frames,
 * SQL and parser vocabulary are all §20 violations, and checking for them here
 * means each individual assertion does not have to remember to.
 */
function assertSafeMessage(message) {
  assert.equal(typeof message, "string");
  assert.doesNotMatch(message, /\/home\/|\/tmp\/|[A-Z]:\\/, "no filesystem path");
  assert.doesNotMatch(message, /\bat \S+ \(/, "no stack frame");
  assert.doesNotMatch(
    message,
    /SELECT |INSERT |relation |pg_|ECONNREFUSED/i,
    "no SQL or database internals",
  );
  assert.doesNotMatch(
    message,
    /pdfjs|InvalidPDF|XRef|node_modules/i,
    "no parser internals",
  );
}

/**
 * Assert that `fn` throws an AppError carrying `statusCode`, with a safe message.
 *
 * `statusCode` rather than `status`: that is the property SP-V2-001's AppError
 * defines and the central error handler reads. Asserting on a property the class
 * does not have would compare `undefined` with `undefined` and pass for anything,
 * so the name matters more than it looks.
 */
function assertThrowsWithStatus(statusCode, fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, "AppError");
    assert.equal(
      err.statusCode,
      statusCode,
      `expected ${statusCode}, got ${err.statusCode}`,
    );
    assertSafeMessage(err.message);
    return true;
  });
}

// ── validation: what a file actually is ────────────────────────────────────
describe("validateUpload", () => {
  it("accepts a plain text file and reports the type the backend determined", () => {
    const result = validate(SHORT_TXT);
    assert.deepEqual(result, {
      mimeType: "text/plain",
      extension: "txt",
      size: bytes(SHORT_TXT).byteLength,
    });
  });

  it("accepts a PDF on its signature, not on the client's word", () => {
    const pdf = multiPagePdf();
    // The claim is deliberately wrong-but-tolerated (curl's default); the
    // signature is what decides, and the returned type is the canonical one.
    const result = validate(pdf, { clientMimeType: "application/octet-stream" });
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.extension, "pdf");
  });

  it("rejects an unsupported extension with 415", () => {
    assertThrowsWithStatus(415, () => validate(UNSUPPORTED_EXTENSION));
  });

  it("rejects a client type that contradicts the extension with 415", () => {
    assertThrowsWithStatus(415, () => validate(SHORT_TXT, { clientMimeType: "image/png" }));
  });

  it("tolerates a missing client type, because content is the real check", () => {
    assert.equal(validate(SHORT_TXT, { clientMimeType: undefined }).mimeType, "text/plain");
    assert.equal(validate(SHORT_TXT, { clientMimeType: "" }).mimeType, "text/plain");
    // Parameters after the type are ignored, as every HTTP client sends them.
    assert.equal(
      validate(SHORT_TXT, { clientMimeType: "text/plain; charset=utf-8" }).mimeType,
      "text/plain",
    );
  });

  it("rejects a binary wearing a .txt extension with 415", () => {
    // PNG magic bytes named sneaky.txt. The extension and the claim agree with
    // each other and both are wrong — which is precisely why neither is trusted.
    assertThrowsWithStatus(415, () => validate(PNG_NAMED_TXT));
  });

  it("rejects plain text wearing a .pdf extension with 415", () => {
    assertThrowsWithStatus(415, () => validate(TXT_NAMED_PDF));
  });

  it("accepts text carrying a few stray NUL bytes, and rejects text made of them", () => {
    // The binary heuristic is about DENSITY, not presence, and both halves of that
    // are load-bearing. A damaged export with a handful of NULs is a document the
    // student should keep — the normalizer strips them (§15), which it can only do
    // for files that got this far. A buffer that is mostly NULs is a binary with no
    // signature, and letting it through would turn a clear 415 into a confusing
    // `failed` material.
    const prose = "Mitochondria produce ATP.".repeat(40); // ~1000 bytes
    assert.equal(
      validate(SHORT_TXT, { buffer: Buffer.from(`${prose}${NUL}${NUL}`, "utf8") }).mimeType,
      "text/plain",
    );
    assertThrowsWithStatus(415, () =>
      validate(SHORT_TXT, {
        // UTF-16LE ASCII: every other byte is NUL. No magic number identifies it,
        // so density is the only thing that can.
        buffer: Buffer.from(prose, "utf16le"),
      }),
    );
  });

  it("rejects an empty file with 400 before any material exists", () => {
    assertThrowsWithStatus(400, () => validate(ZERO_BYTE_TXT));
  });

  it("rejects an oversized buffer with 413", () => {
    assertThrowsWithStatus(413, () =>
      validate(SHORT_TXT, {
        buffer: Buffer.alloc(config.limits.materialUploadBytes + 1, 0x41),
      }),
    );
  });

  it("rejects a missing or blank filename with 400", () => {
    for (const filename of [undefined, "", "   ", null, 42]) {
      assertThrowsWithStatus(400, () => validate(SHORT_TXT, { filename }));
    }
  });

  it("rejects an over-long filename with 400", () => {
    assertThrowsWithStatus(400, () =>
      validate(SHORT_TXT, {
        filename: `${"a".repeat(config.limits.materialFilenameLength)}.txt`,
      }),
    );
  });

  it("never echoes an unsanitised client type back in an error", () => {
    try {
      validate(SHORT_TXT, { clientMimeType: "<script>alert(1)</script>" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.doesNotMatch(err.message, /[<>]/, "markup must not survive into the message");
      assertSafeMessage(err.message);
    }
  });

  it("takes the last extension, as every filesystem does", () => {
    assert.equal(extensionOf("notes.pdf.txt"), "txt");
    assert.equal(extensionOf("NOTES.TXT"), "txt");
    assert.equal(extensionOf("archive.tar.gz"), "gz");
    // A leading dot is a dotfile, not an extension.
    assert.equal(extensionOf(".txt"), "");
    assert.equal(extensionOf("noextension"), "");
    assert.equal(extensionOf(undefined), "");
  });

  it("allows exactly PDF and TXT this iteration", () => {
    assert.deepEqual([...ALLOWED_MATERIAL_EXTENSIONS].sort(), ["pdf", "txt"]);
  });

  it("accepts a filename containing traversal characters — the name is not a path", () => {
    // A filename is display metadata; the storage key is generated. So "../../"
    // in a name is not dangerous and must not be rejected: rejecting it would
    // imply the name reaches the filesystem, which it never does.
    const result = validate(SHORT_TXT, { filename: "../../etc/passwd.txt" });
    assert.equal(result.mimeType, "text/plain");
  });
});

// ── extraction ─────────────────────────────────────────────────────────────
describe("extractDocument on plain text", () => {
  it("decodes UTF-8 and reports no pages", async () => {
    const { pages, pageCount } = await extractDocument({
      buffer: bytes(SHORT_TXT),
      mimeType: "text/plain",
    });
    assert.equal(pageCount, null, "plain text has no pages — NULL, never 1");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].pageNumber, null);
    assert.equal(pages[0].text, SHORT_TXT.content);
  });

  it("survives invalid UTF-8 rather than rejecting the document", async () => {
    // One bad byte in otherwise readable text: a Latin-1 export. §14's "handle
    // invalid input safely" means the student keeps their notes.
    const buffer = Buffer.concat([
      Buffer.from("Caf", "utf8"),
      Buffer.from([0xe9]), // é in Latin-1, invalid on its own in UTF-8
      Buffer.from(" notes on osmosis", "utf8"),
    ]);
    const { pages } = await extractDocument({ buffer, mimeType: "text/plain" });
    assert.match(pages[0].text, /Caf.? ?notes on osmosis/);
  });

  it("rejects a file that is overwhelmingly undecodable", async () => {
    // Not text in any encoding this decoder can read. Distinguished from the case
    // above by proportion, not by the presence of a bad byte.
    const buffer = Buffer.alloc(400, 0x80); // continuation bytes, no lead bytes
    await assert.rejects(
      () => extractDocument({ buffer, mimeType: "text/plain" }),
      (err) => {
        assert.ok(err instanceof ExtractionError);
        assertSafeMessage(err.safeMessage);
        return true;
      },
    );
  });

  it("refuses a type it has no extractor for", async () => {
    await assert.rejects(
      () =>
        extractDocument({
          buffer: Buffer.from("x"),
          mimeType: "application/msword",
        }),
      (err) => {
        assert.ok(err instanceof ExtractionError);
        assertSafeMessage(err.safeMessage);
        return true;
      },
    );
  });
});

describe("extractDocument on PDF", () => {
  it("returns one entry per page, with the parser's own page numbers", async () => {
    const { pages, pageCount } = await extractDocument({
      buffer: bytes(multiPagePdf()),
      mimeType: "application/pdf",
    });

    assert.equal(pageCount, 3);
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.map((page) => page.pageNumber),
      [1, 2, 3],
      "page numbers come from the parser, 1-based",
    );

    // Each fixture page names itself, so this asserts that page N's text is
    // page N's text — the property that makes page attribution meaningful
    // rather than merely present.
    assert.match(pages[0].text, /Page One/);
    assert.match(pages[1].text, /Page Two/);
    assert.match(pages[2].text, /Page Three/);
    assert.doesNotMatch(pages[0].text, /Page Two/, "pages must not bleed together");
    assert.match(pages[1].text, /Mitochondria/);
  });

  it("fails safely on a malformed PDF", async () => {
    // §22's "malformed PDF fails safely". The fixture has a valid %PDF- signature
    // and nonsense after it, so it passes validation and reaches the parser —
    // which is the boundary worth testing.
    await assert.rejects(
      () =>
        extractDocument({
          buffer: bytes(MALFORMED_PDF),
          mimeType: "application/pdf",
        }),
      (err) => {
        assert.ok(err instanceof ExtractionError);
        // The internal message may name the parser; the client-facing one may not.
        assertSafeMessage(err.safeMessage);
        assert.match(err.safeMessage, /not a valid PDF|damaged|could not be read/i);
        return true;
      },
    );
  });

  it("parses a PDF with no text layer and yields no text", async () => {
    // The stand-in for a scan. It must PARSE — the failure §17 cares about is
    // "no content", not "no parse", and conflating them would hide either.
    const { pages, pageCount } = await extractDocument({
      buffer: bytes(textlessPdf()),
      mimeType: "application/pdf",
    });
    assert.equal(pageCount, 1);
    assert.equal(
      pages.some((page) => hasMeaningfulText(normalizeText(page.text))),
      false,
      "a textless PDF must produce nothing meaningful — §17's gate depends on this",
    );
  });
});

// ── normalization: §15's documented steps ──────────────────────────────────
describe("normalizeText", () => {
  it("produces exactly the documented output for the messy fixture", () => {
    // The expectation is written out by hand in the fixture file rather than
    // computed: comparing normalizeText(input) against something built by calling
    // normalizeText would pass whatever either did.
    assert.equal(normalizeText(MESSY_TXT.content), MESSY_TXT_NORMALIZED);
  });

  it("converts every line ending to LF", () => {
    assert.equal(normalizeText("a\r\nb\rc\nd"), "a\nb\nc\nd");
    // CRLF must become ONE newline: replacing lone CR first would invent a
    // paragraph break in every Windows document.
    assert.equal(normalizeText("a\r\n\r\nb"), "a\n\nb");
    // U+2028 LINE SEPARATOR is a line break no \r\n-only implementation notices.
    assert.equal(normalizeText(`a${LS}b`), "a\nb");
  });

  it("removes NUL bytes and control characters but keeps tab and newline", () => {
    assert.equal(normalizeText(`a${NUL}b`), "ab");
    assert.equal(normalizeText(`a${NUL}${NUL}${NUL}b`), "ab");
    assert.equal(normalizeText("a\tb"), "a\tb", "a single tab is preserved");
    assert.equal(normalizeText("a\nb"), "a\nb", "a single newline is preserved");
  });

  it("removes zero-width characters and the BOM", () => {
    assert.equal(normalizeText(`${BOM}photo${ZWSP}synthesis`), "photosynthesis");
    assert.equal(normalizeText(`a${ZWNJ}${ZWJ}${WJ}b`), "ab");
  });

  it("folds exotic spaces to a plain space", () => {
    assert.equal(normalizeText(`a${NBSP}b`), "a b");
    assert.equal(normalizeText(`a${THIN_SPACE}b${IDEOGRAPHIC_SPACE}c`), "a b c");
  });

  it("collapses horizontal whitespace runs and strips trailing whitespace", () => {
    assert.equal(normalizeText("a   b"), "a b");
    assert.equal(normalizeText("a\t\t\tb"), "a b");
    assert.equal(normalizeText("a  \nb"), "a\nb");
  });

  it("collapses blank-line runs to exactly one, preserving paragraphs", () => {
    assert.equal(normalizeText("a\n\n\n\n\nb"), "a\n\nb");
    assert.equal(normalizeText("a\n\nb"), "a\n\nb", "one blank line IS a paragraph break");
    // A "blank" line with spaces on it counts as blank: trailing whitespace is
    // stripped before blank runs are collapsed, and the order matters.
    assert.equal(normalizeText("a\n   \n   \nb"), "a\n\nb");
  });

  it("trims the whole document", () => {
    assert.equal(normalizeText("\n\n  Cell Biology  \n\n"), "Cell Biology");
  });

  it("does NOT apply NFKC — subscripts and superscripts survive", () => {
    // The reason the normalizer says no to NFKC: it would rewrite H₂O to H2O and
    // πr² to πr2, which in a study document is a change of meaning, not a tidy-up.
    assert.equal(normalizeText("Water is H₂O"), "Water is H₂O");
    assert.equal(normalizeText("area = πr²"), "area = πr²");
    assert.equal(normalizeText("½ of the figure"), "½ of the figure");
  });

  it("does not rewrite the user's words", () => {
    const prose = "The mitochondrion is the powerhouse of the cell.";
    assert.equal(normalizeText(prose), prose);
    // Line-structured content — code, lists, tables — keeps its structure.
    const code = "for (i = 0; i < n; i++) {\n\tsum += i;\n}";
    assert.equal(normalizeText(code), code);
  });

  it("is deterministic and idempotent", () => {
    const once = normalizeText(MESSY_TXT.content);
    assert.equal(normalizeText(MESSY_TXT.content), once, "same input, same output");
    assert.equal(normalizeText(once), once, "normalizing twice changes nothing");
  });

  it("handles non-strings and empty input without throwing", () => {
    for (const input of [undefined, null, 42, {}, ""]) {
      assert.equal(normalizeText(input), "");
    }
  });
});

describe("hasMeaningfulText", () => {
  it("accepts any non-whitespace content, however short", () => {
    // A one-line note is a legitimate document; a length heuristic would be
    // guessing at the user's intent.
    assert.equal(hasMeaningfulText("Exam: Friday"), true);
    assert.equal(hasMeaningfulText("x"), true);
  });

  it("rejects whitespace-only and non-string input", () => {
    for (const input of ["", "   ", "\n\n\t\n", undefined, null, 42]) {
      assert.equal(hasMeaningfulText(input), false);
    }
  });

  it("rejects the empty-document fixture after normalization", () => {
    // §17 at the module level: this is the file that must not become a `ready`
    // material.
    assert.equal(hasMeaningfulText(normalizeText(EMPTY_TXT.content)), false);
  });
});

// ── chunking ───────────────────────────────────────────────────────────────
/**
 * A document of `length` characters, deterministic and NON-REPEATING.
 *
 * Every sentence is numbered, which matters for the overlap and coverage tests
 * below: those measure the longest suffix of one chunk that is a prefix of the
 * next, and in text built from a repeated sentence that measurement finds a
 * spurious match hundreds of characters long. Numbering makes each position in
 * the document distinguishable, so the measured overlap is the real one.
 */
function prose(length) {
  let text = "";
  for (let n = 1; text.length < length; n++) {
    text += `Note ${n}: photosynthesis converts light into chemical energy. `;
  }
  return text.slice(0, length);
}

/** The longest suffix of `before` that is also a prefix of `after`. */
function sharedRun(before, after) {
  const limit = Math.min(before.length, after.length);
  for (let length = limit; length > 0; length--) {
    if (before.endsWith(after.slice(0, length))) return length;
  }
  return 0;
}

describe("chunkText", () => {
  it("exposes the configuration the docs quote, inside §16's bands", () => {
    assert.equal(chunkingConfig.size, CHUNK_SIZE);
    assert.equal(chunkingConfig.overlap, CHUNK_OVERLAP);
    assert.ok(CHUNK_SIZE >= 1500 && CHUNK_SIZE <= 2000, "§16: 1500–2000 characters");
    assert.ok(CHUNK_OVERLAP >= 200 && CHUNK_OVERLAP <= 300, "§16: 200–300 characters");
    assert.ok(CHUNK_OVERLAP < CHUNK_SIZE);
  });

  it("returns one chunk for a short document", () => {
    const chunks = chunkText(SHORT_TXT.content);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].index, 0);
    assert.equal(chunks[0].content, SHORT_TXT.content);
    assert.equal(chunks[0].charCount, SHORT_TXT.content.length);
    assert.equal(chunks[0].pageNumber, null);
  });

  it("produces contiguous 0-based indexes in order", () => {
    const chunks = chunkText(prose(9000));
    assert.ok(chunks.length > 1, "9000 characters must not fit in one chunk");
    assert.deepEqual(
      chunks.map((chunk) => chunk.index),
      chunks.map((_, position) => position),
      "indexes must be 0..n-1 with no gaps",
    );
  });

  it("starts at startIndex when continuing a sequence", () => {
    const chunks = chunkText(prose(5000), { startIndex: 7 });
    assert.equal(chunks[0].index, 7);
    assert.deepEqual(
      chunks.map((chunk) => chunk.index),
      chunks.map((_, position) => position + 7),
    );
  });

  it("never emits an empty chunk and never exceeds CHUNK_SIZE", () => {
    for (const length of [1, 100, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 12_000]) {
      for (const chunk of chunkText(prose(length))) {
        assert.ok(chunk.content.trim().length > 0, `empty chunk at length ${length}`);
        assert.ok(
          chunk.content.length <= CHUNK_SIZE,
          `chunk of ${chunk.content.length} exceeds CHUNK_SIZE at length ${length}`,
        );
        assert.equal(chunk.charCount, chunk.content.length, "charCount must match");
      }
    }
  });

  it("overlaps consecutive chunks by roughly the configured amount", () => {
    const chunks = chunkText(prose(12_000));
    assert.ok(chunks.length >= 6);

    for (let i = 1; i < chunks.length; i++) {
      // This is §16's "predictable overlap", measured rather than assumed — the
      // property an off-by-one in the cursor arithmetic breaks silently.
      const shared = sharedRun(chunks[i - 1].content, chunks[i].content);

      assert.ok(shared > 0, `chunks ${i - 1} and ${i} do not overlap at all`);
      // Bounded above by the configured overlap, since trimming a chunk's edges
      // can only shorten the repeated span, and below generously, because a
      // boundary snap moves the cut and the repeated span with it.
      assert.ok(
        shared <= CHUNK_OVERLAP,
        `overlap ${shared} exceeds CHUNK_OVERLAP ${CHUNK_OVERLAP}`,
      );
      assert.ok(
        shared >= CHUNK_OVERLAP / 3,
        `overlap ${shared} is far below CHUNK_OVERLAP ${CHUNK_OVERLAP}`,
      );
    }
  });

  it("covers the whole document — nothing is dropped", () => {
    // The complement of the overlap test: overlap means text repeats, and this
    // means no text goes missing. Reassembling by removing each chunk's overlap
    // with what precedes it must reproduce the source.
    const source = prose(9000).trim();
    const chunks = chunkText(source);

    let rebuilt = chunks[0].content;
    for (let i = 1; i < chunks.length; i++) {
      const current = chunks[i].content;
      rebuilt += current.slice(sharedRun(rebuilt, current));
    }
    // Whitespace-insensitive: boundaries fall on whitespace, which each chunk
    // trims away, so a join loses a space rather than a character of content.
    assert.equal(
      rebuilt.replaceAll(/\s+/g, " "),
      source.replaceAll(/\s+/g, " "),
      "reassembling the chunks must reproduce the document",
    );
  });

  it("prefers a paragraph boundary when one is in range", () => {
    // A paragraph break placed just inside the search window before the target
    // cut. The first chunk should end there rather than mid-sentence.
    const head = prose(CHUNK_SIZE - 200).trim();
    const chunks = chunkText(`${head}\n\n${prose(3000)}`);
    assert.equal(
      chunks[0].content,
      head,
      "the cut must land on the paragraph break, not at CHUNK_SIZE",
    );
  });

  it("still chunks text with no whitespace at all", () => {
    // Minified JSON, a base64 blob. The boundary search must give up and cut at
    // full width rather than search the whole document or degenerate.
    const blob = "a".repeat(10_000);
    const chunks = chunkText(blob);
    assert.ok(chunks.length >= 5);
    for (const chunk of chunks) {
      assert.ok(chunk.content.length <= CHUNK_SIZE);
    }
    assert.equal(chunks[0].content.length, CHUNK_SIZE, "cuts at full width");
  });

  it("is deterministic: the same text yields identical chunks", () => {
    const source = normalizeText(MULTI_CHUNK_TXT.content);
    assert.deepEqual(chunkText(source), chunkText(source));
    assert.ok(chunkText(source).length > 1, "the fixture must produce several chunks");
  });

  it("terminates on pathological input", () => {
    // §16's "no infinite loops", as a bounded assertion rather than a hope. Each
    // of these has previously been the shape that stalls a naive cursor.
    const started = Date.now();
    for (const input of [
      "\n".repeat(5000),
      " ".repeat(5000),
      `${"a".repeat(3000)}\n\n`,
      "a\n".repeat(3000),
      ".".repeat(5000),
      `${" ".repeat(CHUNK_SIZE)}x`,
    ]) {
      for (const chunk of chunkText(input)) {
        assert.ok(chunk.content.trim().length > 0);
      }
    }
    assert.ok(Date.now() - started < 5000, "chunking must not hang");
  });

  it("returns nothing for empty or non-string input", () => {
    for (const input of ["", "   ", "\n\n\n", undefined, null, 42]) {
      assert.deepEqual(chunkText(input), []);
    }
  });
});

describe("chunkPages", () => {
  /** Extract, normalize per page, and chunk — the pipeline's own sequence. */
  async function chunkFixture(fixture, mimeType) {
    const { pages, pageCount } = await extractDocument({
      buffer: bytes(fixture),
      mimeType,
    });
    const chunks = chunkPages(
      pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: normalizeText(page.text),
      })),
    );
    return { chunks, pageCount };
  }

  it("keeps one continuous 0-based sequence across pages", async () => {
    const { chunks } = await chunkFixture(multiPagePdf(), "application/pdf");

    assert.deepEqual(
      chunks.map((chunk) => chunk.index),
      chunks.map((_, position) => position),
      "indexes continue across pages rather than restarting per page",
    );
    // Every chunk carries a real page number, and they are non-decreasing —
    // document order.
    const pageNumbers = chunks.map((chunk) => chunk.pageNumber);
    assert.deepEqual(pageNumbers, [...pageNumbers].sort((a, b) => a - b));
    assert.deepEqual([...new Set(pageNumbers)], [1, 2, 3]);
  });

  it("gives every chunk of a long single page that page's number", async () => {
    // The case a naive implementation gets wrong by numbering CHUNKS instead of
    // pages: one page, several chunks, all of them page 1.
    const { chunks, pageCount } = await chunkFixture(
      longSinglePagePdf(),
      "application/pdf",
    );
    assert.equal(pageCount, 1);
    assert.ok(chunks.length > 1, "the fixture must produce more than one chunk");
    assert.deepEqual(
      [...new Set(chunks.map((chunk) => chunk.pageNumber))],
      [1],
      "every chunk of page 1 is page 1",
    );
  });

  it("carries NULL through for text, which has no pages", async () => {
    const { chunks } = await chunkFixture(MULTI_CHUNK_TXT, "text/plain");
    assert.ok(chunks.length > 1);
    assert.deepEqual(
      [...new Set(chunks.map((chunk) => chunk.pageNumber))],
      [null],
      "a page number is never invented for plain text",
    );
  });

  it("skips pages with no text without breaking the index sequence", () => {
    const chunks = chunkPages([
      { pageNumber: 1, text: "" },
      { pageNumber: 2, text: "Mitochondria generate ATP." },
      { pageNumber: 3, text: "   " },
      { pageNumber: 4, text: "Chloroplasts carry out photosynthesis." },
    ]);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.index, chunk.pageNumber]),
      [
        [0, 2],
        [1, 4],
      ],
      "a blank cover page must not consume an index or produce an empty chunk",
    );
  });
});
