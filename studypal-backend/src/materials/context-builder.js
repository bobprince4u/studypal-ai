/**
 * Context construction: retrieved chunks → one bounded, source-numbered block.
 *
 * A pure function of its input, in its own module rather than inline in the chat
 * service, because it is the piece that decides two things worth testing on their
 * own (§17, §18):
 *
 *   WHAT THE MODEL SEES, including the source boundaries. Chunks are not
 *   concatenated into a wall of prose — each is fenced and labelled `[Source N]`
 *   with its material and page, so the model can attribute a statement to a
 *   source and the backend can map that attribution back to a real chunk. Losing
 *   the boundary loses the citation.
 *
 *   HOW MUCH IT SEES. A hard character budget, enforced here, before anything is
 *   sent. §18's "do not send arbitrarily large retrieved content".
 *
 * The `N` in `[Source N]` is 1-BASED and is the model's only handle on a source.
 * It is an index into the array this function returns — deliberately not a chunk
 * id, not a material id, and not a filename. The model is given the smallest
 * possible token that identifies a source, so that even a model inventing one can
 * only produce a number that either indexes a real retrieved chunk or does not.
 * §24: the backend owns citation identity. See source-mapper.js.
 */

import { config } from "../config/env.js";

/**
 * Build the retrieved-material block and the source list it is numbered against.
 *
 * Chunks are taken in the order given — most relevant first, as the retrieval
 * query ordered them — and the budget is applied by DROPPING WHOLE CHUNKS from
 * the end, never by truncating one. A half chunk is a passage that stops
 * mid-sentence, which invites the model to complete the thought itself; that is
 * precisely the fabrication this feature is built to avoid, and it would be
 * cited as a real source.
 *
 * The first chunk is always included even if it alone exceeds the budget. The
 * alternative is returning no context for a large chunk, which reads to the rest
 * of the pipeline as "no relevant material" and produces an "your materials do
 * not cover this" for material that does — a silent false negative, where
 * exceeding the budget slightly is a visible, bounded cost. With CHUNK_SIZE at
 * 1800 and the budget at 12000 this cannot arise from the current chunker; it is
 * a guard for a future one.
 *
 * @param {import("./retrieval.service.js").RetrievedChunk[]} chunks
 *   most relevant first
 * @param {object} [options]
 * @param {number} [options.maxChars] budget override, for tests
 * @returns {{context: string, sources: import("./retrieval.service.js").RetrievedChunk[],
 *   usedChars: number, droppedChunks: number}}
 *   `sources` is exactly the chunks the returned `context` contains, in the same
 *   order, so `sources[n - 1]` is `[Source n]`.
 */
export function buildContext(chunks, options = {}) {
  const maxChars = options.maxChars ?? config.rag.maxContextChars;

  const included = [];
  const blocks = [];
  let usedChars = 0;

  for (const chunk of chunks) {
    const block = formatSource(chunk, included.length + 1);

    // Budgeted on the formatted block, not the raw content: the labels are part
    // of what is sent, so measuring only `content` would understate the payload
    // by ~60 characters per source and let the budget be quietly exceeded.
    if (included.length > 0 && usedChars + block.length > maxChars) {
      // Stop rather than skip-and-continue. Chunks arrive in descending
      // relevance, so a later one is never a better use of the remaining budget
      // than the one that just did not fit — and skipping to fill the gap with a
      // less relevant chunk would break the "sources are the top matches"
      // property the ordering tests assert.
      break;
    }

    included.push(chunk);
    blocks.push(block);
    usedChars += block.length;
  }

  return {
    context: blocks.join("\n\n"),
    sources: included,
    usedChars,
    droppedChunks: chunks.length - included.length,
  };
}

/**
 * One `[Source N]` block.
 *
 * The format is flat labelled lines rather than JSON or XML, for one reason: the
 * chunk content is UNTRUSTED text from a student's uploaded document (§19), and a
 * structured envelope invites the model to treat a structurally convincing
 * payload inside the content as part of the envelope. Text that tries to forge a
 * `[Source 4]` header here is simply text inside Source N's Content, which the
 * prompt has already said is quoted material and not instructions.
 *
 * `Page:` is omitted entirely when the page is unknown, rather than sent as
 * "Page: null" or "Page: 1". §13 of SP-V2-003 chose NULL over an invented page
 * number because a wrong citation is worse than an absent one, and a model shown
 * "Page: null" will occasionally cite page null.
 */
function formatSource(chunk, ordinal) {
  const lines = [`[Source ${ordinal}]`, `Material: ${chunk.filename}`];

  if (chunk.pageNumber !== null && chunk.pageNumber !== undefined) {
    lines.push(`Page: ${chunk.pageNumber}`);
  }

  lines.push(`Chunk: ${chunk.chunkIndex}`, "Content:", chunk.content);

  return lines.join("\n");
}
