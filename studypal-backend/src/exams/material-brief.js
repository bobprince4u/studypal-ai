/**
 * Material briefing for an exam: which of the learner's documents it may be
 * built on, and a bounded extract of what they contain.
 *
 * The exams' equivalent of src/study-plans/material-brief.js, and named to match
 * so the parallel is findable. It is a SEPARATE MODULE rather than a shared one,
 * and that is a decision rather than an oversight — see the note at the bottom.
 *
 * WHAT IS REUSED, AND WHAT IS NOT (§6, §14)
 * -----------------------------------------
 * §14 is explicit: "Do not implement a new vector-search system here. Reuse
 * SP-V2-004." There is no vector SQL in this directory and no second similarity
 * search. The embedding provider, the retrieval service and the context builder
 * are used unmodified — retrieveRelevantChunks() and buildContext() respectively
 * — and material ownership is resolved by SP-V2-003's own repository.
 *
 * What is new here is the QUESTION. Chat retrieves against something a student
 * typed; an exam has no question, so one is composed from the subject and
 * topics. That is the only retrieval decision this module makes.
 *
 * WHY THIS RETURNS `sources` AND THE STUDY-PLAN VERSION DOES NOT
 * -------------------------------------------------------------
 * This is the functional difference between the two, and the reason the exam
 * version exists. §14 asks for source traceability per QUESTION: an exam
 * question generated from a document records which material and which chunk it
 * came from, so SP-V2-007 can later say "you keep getting the questions from
 * chapter 4 wrong". That needs `sources[n - 1]` to still carry its `chunkId` and
 * `materialId` when the model's `sourceNumber` comes back.
 *
 * A study plan has no equivalent: it records material ids on the plan, not a
 * chunk per task, so buildMaterialBrief returns a count and discards the rest.
 * src/materials/source-mapper.js drops `chunkId` for the same reason — it is an
 * internal surrogate key that a chat citation has no use for — which is why that
 * function, despite looking like the right one, is not reusable here.
 *
 * ONE RETRIEVAL PER MATERIAL, IN PARALLEL
 * ---------------------------------------
 * Deliberately not one search across everything the user owns, for the two
 * reasons SP-V2-005 records: SCOPE, because an exam is grounded in the materials
 * the learner named and an unscoped search would pull in documents they did not
 * choose; and FAIRNESS, because a single top-K across ten documents can
 * legitimately return every chunk from one of them, leaving a ten-document exam
 * tested entirely on one. The interleave below makes the character budget cut
 * evenly across materials.
 */

import { buildContext } from "../materials/context-builder.js";
import { config } from "../config/env.js";
import * as materialRepository from "../materials/material.repository.js";
import { retrieveRelevantChunks } from "../materials/retrieval.service.js";

/**
 * Resolve requested material ids to materials this user actually owns (§6).
 *
 * §6: "Do not invent material IDs or bypass ownership checks." The ids arrive
 * from a request body and are resolved here against the database with the owner
 * in the WHERE clause; anything that is not theirs, or does not exist, is simply
 * absent from the result. The two are indistinguishable on purpose — a caller
 * must not be able to learn that a material id is real from the shape of the
 * rejection.
 *
 * Aliases are assigned in the caller's order, which findOwnedByIds preserves, so
 * the same request always produces the same alias for the same material.
 *
 * @param {Array<number>} materialIds
 * @param {number} userId
 * @returns {Promise<{materials: Array<{id: number, filename: string,
 *   alias: string}>, missing: number}>} `missing` is how many requested ids were
 *   not theirs — the service refuses the request rather than quietly generating
 *   from fewer documents than the learner named
 */
export async function resolveMaterials(materialIds, userId) {
  const rows = await materialRepository.findOwnedByIds(materialIds, userId);

  return {
    materials: rows.map((row, index) => ({
      id: row.id,
      filename: row.original_filename,
      alias: `MATERIAL_${index + 1}`,
    })),
    missing: materialIds.length - rows.length,
  };
}

/**
 * Retrieve and format the material extracts for one exam.
 *
 * Returns an empty context and no sources for a topic-only exam, which §6 makes
 * a first-class case rather than a degraded one — the caller passes the result
 * through unchanged and buildExamPrompt omits the section entirely.
 *
 * THROWS on a provider failure rather than degrading to a topic-only exam. A
 * learner who scoped an exam to three documents and silently received questions
 * grounded in none of them has been given something other than what they asked
 * for, with nothing in the response to say so. The service turns this into the
 * same AI_UNAVAILABLE 500 the chat and plan paths use.
 *
 * @param {object} input
 * @param {number} input.userId
 * @param {Array<{id: number, filename: string, alias: string}>} input.materials
 * @param {string} input.subject
 * @param {Array<string>} input.topics
 * @returns {Promise<{context: string, sources: Array<{chunkId: number,
 *   materialId: number, filename: string}>}>} `sources` is ordered so that the
 *   model's `[Source N]` is `sources[N - 1]`
 */
export async function buildExamMaterialContext({
  userId,
  materials,
  subject,
  topics,
}) {
  if (materials.length === 0) return { context: "", sources: [] };

  const question = retrievalQuery(subject, topics);

  const perMaterial = await Promise.all(
    materials.map(async (material) => {
      const { chunks } = await retrieveRelevantChunks({
        userId,
        materialId: material.id,
        question,
      });

      // The alias replaces the filename BEFORE the chunk reaches the context
      // builder, so the `Material:` line the model reads carries the label the
      // EXAM REQUEST section introduced. A new object rather than a mutation:
      // the retrieval result belongs to the retrieval service, and rewriting its
      // fields in place would make a shared module's output depend on who read
      // it first.
      return chunks.map((chunk) => ({ ...chunk, filename: material.alias }));
    }),
  );

  const { context, sources } = buildContext(interleave(perMaterial), {
    // The exam budget, not the RAG one. See config.exam.maxContextChars.
    maxChars: config.exam.maxContextChars,
  });

  return { context, sources };
}

/**
 * The text the extracts are retrieved against.
 *
 * An exam has no question, so one is composed from what the learner did say. The
 * topics carry most of the signal; the subject is included because §2 allows an
 * exam with no topics, which would otherwise have nothing to search with.
 *
 * Bounded by config.rag.maxQuestionChars, the same ceiling a typed question has
 * — an embedding model truncates its input anyway, so the tail would be billed
 * for without participating in the search.
 */
function retrievalQuery(subject, topics) {
  const text = topics.length > 0 ? `${subject}: ${topics.join(", ")}` : subject;
  return text.slice(0, config.rag.maxQuestionChars);
}

/**
 * Round-robin the per-material chunk lists into one relevance-fair ordering.
 *
 * Each material's chunks arrive most-relevant-first. Taking one from each in
 * turn means the list is every material's best chunk, then every material's
 * second-best, and so on — so when buildContext stops at the character budget it
 * has spent that budget across as many materials as it could, rather than
 * exhausting the first material's chunks before reaching the second.
 *
 * DUPLICATED FROM src/study-plans/material-brief.js, DELIBERATELY. Sharing it
 * would mean one feature folder importing another's internals — an exam
 * generation that breaks when a study-plan refactor lands — or a new module in
 * src/materials/ that only one of the two callers uses, since §25 forbids
 * modifying SP-V2-005 to adopt it. §23's warning about duplication is about
 * RULES living in two places; this is nine lines of ordering with no rule in it,
 * and the same judgement the exam validator's clampText records.
 */
function interleave(lists) {
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const merged = [];

  for (let round = 0; round < longest; round += 1) {
    for (const list of lists) {
      if (round < list.length) merged.push(list[round]);
    }
  }

  return merged;
}
