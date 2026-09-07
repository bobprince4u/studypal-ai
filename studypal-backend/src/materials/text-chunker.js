/**
 * Character-based text chunking — deterministic, ordered, terminating.
 *
 * Splits normalized document text into overlapping windows sized for retrieval.
 * No embeddings, no tokenizer, no model: §16 asks for character-based chunking,
 * and characters are the right unit here precisely because they need no
 * dependency and no vocabulary — the same text yields the same chunks on every
 * machine and every version, which is what makes the output reproducible.
 *
 * WHY OVERLAP
 * -----------
 * A hard split loses whatever straddles the boundary. If a definition begins 40
 * characters before the cut, one chunk ends mid-sentence and the next starts
 * mid-sentence, and neither answers a question about it. Overlapping the window
 * means every span of ~CHUNK_OVERLAP characters appears whole in at least one
 * chunk. The cost is duplicated text — about 13% at these settings — which is
 * cheap storage now and cheap embedding later.
 *
 * WHY THE BOUNDARY SEARCH
 * -----------------------
 * A fixed-width cut lands mid-word. Rather than accept that, each cut is nudged
 * backwards to the nearest natural break inside a bounded search window:
 * paragraph, then sentence, then line, then whitespace. Bounded is the important
 * word — the search never gives up more than BOUNDARY_SEARCH_FRACTION of the
 * chunk, so a document with no whitespace at all (minified JSON, a base64 blob)
 * still chunks at full width rather than degenerating.
 *
 * TERMINATION
 * -----------
 * §16 requires no infinite loops, and the loop below advances by
 * `end - CHUNK_OVERLAP`, which is only guaranteed to increase if every chunk is
 * longer than the overlap. Two things make that true: CHUNK_OVERLAP is asserted
 * to be smaller than CHUNK_SIZE minus the largest possible boundary retreat at
 * module load, and the loop takes `Math.max(cursor + 1, …)` as its next position
 * so no arithmetic mistake can stall it. The assertion is the real guarantee; the
 * max() is the seatbelt.
 *
 * Pure and deterministic: no clock, no randomness, no I/O, no configuration read
 * at call time.
 */

/**
 * Target chunk length in characters.
 *
 * 1800 sits in the middle of §16's 1500–2000 band. The band is a retrieval
 * trade-off rather than a technical limit: shorter chunks match a query more
 * precisely but carry less context around the match, longer ones the reverse.
 * 1800 characters is roughly 300 words — a healthy paragraph or two, which is the
 * unit a study document is usually organised in.
 */
export const CHUNK_SIZE = 1800;

/**
 * Characters each chunk repeats from the end of the previous one.
 *
 * 250, mid-range of §16's 200–300. Comfortably longer than a sentence, so a
 * definition or formula split by a cut survives intact in the following chunk.
 */
export const CHUNK_OVERLAP = 250;

/**
 * How far back from the target cut a natural boundary may be sought, as a
 * fraction of CHUNK_SIZE.
 *
 * 0.25 gives a 450-character window at the current size. Large enough to reach
 * the previous paragraph break in ordinary prose; small enough that a chunk never
 * shrinks below 75% of target, which keeps chunk sizes predictable.
 */
const BOUNDARY_SEARCH_FRACTION = 0.25;

/** Absolute search window, in characters. */
const BOUNDARY_SEARCH_WINDOW = Math.floor(CHUNK_SIZE * BOUNDARY_SEARCH_FRACTION);

/**
 * The termination invariant, checked once at module load rather than trusted.
 *
 * Every chunk is at least CHUNK_SIZE - BOUNDARY_SEARCH_WINDOW characters long
 * (the boundary search cannot retreat further), and the cursor advances by
 * chunk length - CHUNK_OVERLAP. That advance is positive only if the overlap is
 * strictly smaller than the shortest possible chunk. Editing these constants to
 * an unsafe combination therefore fails at import — a loud crash on the first
 * test run rather than a request that hangs forever in production.
 */
if (CHUNK_OVERLAP >= CHUNK_SIZE - BOUNDARY_SEARCH_WINDOW) {
  throw new Error(
    `Unsafe chunking configuration: CHUNK_OVERLAP (${CHUNK_OVERLAP}) must be ` +
      `smaller than the shortest possible chunk ` +
      `(CHUNK_SIZE ${CHUNK_SIZE} - boundary window ${BOUNDARY_SEARCH_WINDOW} = ` +
      `${CHUNK_SIZE - BOUNDARY_SEARCH_WINDOW}), or chunking cannot terminate.`,
  );
}

/**
 * Boundary patterns, best first.
 *
 * Each is searched for within the window before the target cut; the first that
 * matches wins. Paragraph beats sentence beats line beats any whitespace, which
 * is the order of how much structural meaning the break carries.
 */
const BOUNDARIES = Object.freeze([
  { name: "paragraph", pattern: /\n\n/g },
  // A sentence end followed by whitespace. Requiring the whitespace is what
  // stops "Fig. 3" and "e.g." from being treated as sentence ends about as often
  // as a full-stop rule can manage without a language model.
  { name: "sentence", pattern: /[.!?]["')\]]?\s/g },
  { name: "line", pattern: /\n/g },
  { name: "whitespace", pattern: /\s/g },
]);

/**
 * Find the best cut position at or before `target`.
 *
 * @param {string} text
 * @param {number} start where the current chunk begins
 * @param {number} target the ideal end position
 * @returns {number} the chosen end position, exclusive
 */
function findCut(text, start, target) {
  const earliest = Math.max(start + 1, target - BOUNDARY_SEARCH_WINDOW);

  for (const { pattern } of BOUNDARIES) {
    // Scan the window forwards and keep the LAST match, which is the break
    // closest to the target — the chunk should be as full as it can be while
    // still ending on a boundary. lastIndexOf would do for fixed strings but not
    // for the sentence pattern, so all four are scanned the same way.
    pattern.lastIndex = earliest;
    let best = -1;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // The cut goes AFTER the matched separator, so the boundary characters stay
      // with the chunk that precedes them and the next chunk starts on content.
      const cut = match.index + match[0].length;
      if (cut > target) break;
      if (cut > earliest) best = cut;
      // Zero-width matches are impossible for these patterns, but a manual
      // advance keeps exec() from being able to spin if one is ever added.
      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
    }
    if (best > start) return best;
  }

  // No boundary in the window: cut at the target. This is the minified-JSON case,
  // and taking the full width is better than searching the whole document for a
  // space that may not exist.
  return target;
}

/**
 * Split text into overlapping chunks.
 *
 * @param {string} text normalized text, from text-normalizer.js
 * @param {object} [options]
 * @param {number|null} [options.pageNumber] page these chunks came from, when the
 *   caller is chunking one page at a time. Passed through to every chunk; NULL
 *   when unknown, never guessed (§13).
 * @param {number} [options.startIndex] first chunk_index to assign, so a caller
 *   chunking page by page can produce one continuous 0-based sequence across the
 *   whole document.
 * @returns {Array<{index: number, content: string, pageNumber: number|null, charCount: number}>}
 *   ordered by index, every chunk non-empty
 */
export function chunkText(text, { pageNumber = null, startIndex = 0 } = {}) {
  if (typeof text !== "string") return [];

  // Trimmed defensively: a caller that skipped normalization would otherwise be
  // able to produce a leading chunk of pure whitespace, which the
  // material_chunks_content_not_blank constraint would then reject at write time
  // — a confusing place to discover it.
  const source = text.trim();
  if (source.length === 0) return [];

  const chunks = [];
  let cursor = 0;
  let index = startIndex;

  while (cursor < source.length) {
    const target = Math.min(cursor + CHUNK_SIZE, source.length);
    // The last chunk always runs to the end: applying a boundary search to it
    // would drop the document's final sentence.
    const end = target >= source.length ? source.length : findCut(source, cursor, target);

    const content = source.slice(cursor, end).trim();
    // A window of pure whitespace yields nothing worth storing. Skipped rather
    // than stored empty, which keeps chunk_index contiguous over real content.
    if (content.length > 0) {
      chunks.push({
        index: index++,
        content,
        pageNumber,
        // Computed from the string actually stored, so it cannot disagree with
        // it — the material_chunks_char_count_matches constraint checks the same
        // equality in the database.
        charCount: content.length,
      });
    }

    if (end >= source.length) break;

    // Step forward, repeating CHUNK_OVERLAP characters. max() with cursor + 1
    // is the seatbelt described in the header: the constant assertion above
    // already guarantees this expression grows.
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

/**
 * Chunk a document that has page boundaries, producing one continuous sequence.
 *
 * Each page is chunked independently so no chunk spans two pages and every chunk
 * can name the page it came from. The trade-off is real and deliberate: a
 * paragraph continuing across a page break is split at the page boundary rather
 * than kept whole. That is the right way round for a study tool, where being able
 * to say "page 12" about a retrieved passage is worth more than the few sentences
 * that straddle a break — and a chunk drawn from two pages could only be labelled
 * with one of them, or with none.
 *
 * @param {Array<{pageNumber: number|null, text: string}>} pages in document order
 * @returns {Array<{index: number, content: string, pageNumber: number|null, charCount: number}>}
 *   one 0-based, contiguous, ordered sequence across all pages
 */
export function chunkPages(pages) {
  const chunks = [];
  for (const page of pages) {
    // startIndex continues from what has already been produced, which is what
    // makes the indexes contiguous across pages rather than restarting per page.
    chunks.push(
      ...chunkText(page.text, {
        pageNumber: page.pageNumber ?? null,
        startIndex: chunks.length,
      }),
    );
  }
  return chunks;
}

/** The configuration, for the docs, the status endpoint and the tests. */
export const chunkingConfig = Object.freeze({
  size: CHUNK_SIZE,
  overlap: CHUNK_OVERLAP,
  boundarySearchWindow: BOUNDARY_SEARCH_WINDOW,
  strategy: "character-window-with-boundary-snap",
});
