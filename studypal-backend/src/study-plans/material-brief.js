/**
 * Material briefing: which of the learner's documents this plan may be built on,
 * and a bounded extract of what they contain.
 *
 * THE ALIAS MECHANISM (§20)
 * -------------------------
 * Materials reach the model as MATERIAL_1, MATERIAL_2 … — labels that exist only
 * inside one prompt and mean nothing anywhere else. The model never sees a
 * database id, so §20's "do NOT allow Gemini to invent database material IDs" is
 * not a rule anyone has to enforce: there is no id in the prompt to copy,
 * mutate, or guess a neighbour of. An alias comes back, the map below turns it
 * into an id, and an alias that was never issued turns into nothing.
 *
 * The map is built from rows the database returned for `WHERE user_id = $2`, so
 * every id it can produce belongs to the requesting user. A plan therefore
 * cannot reference another learner's material even if the model asks for one,
 * and the composite foreign key in 004_study_plans.sql refuses it a second time
 * at the point of INSERT.
 *
 * WHAT IS REUSED, AND WHAT IS NOT (§15)
 * -------------------------------------
 * The embedding provider, the retrieval service and the context builder are used
 * unmodified — src/ai/embedding.service.js, retrieveRelevantChunks() and
 * buildContext() respectively. There is no vector SQL in this directory and no
 * second similarity search: §15's "do not turn the study-plan generator into a
 * second RAG implementation" is satisfied by this module having no search code
 * in it at all.
 *
 * What is new here is the QUESTION. Chat retrieves against something a student
 * typed; a plan has no question, so one is composed from the subject and topics.
 * That is the only retrieval decision this module makes.
 *
 * ONE RETRIEVAL PER MATERIAL, IN PARALLEL
 * ---------------------------------------
 * Deliberately not one search across everything the user owns. Two reasons:
 *
 *   scope — a plan is grounded in the materials the learner named, and an
 *   unscoped search would pull in documents they did not choose for this plan.
 *
 *   fairness — a single top-5 across ten documents can legitimately return five
 *   chunks from one of them, leaving the plan grounded in one document while the
 *   learner named ten. Per-material retrieval gives each one its own candidates,
 *   and the interleave below makes the character budget cut them evenly.
 *
 * The cost is one embedding of the same query per material. They are issued
 * concurrently, so it is one round trip of latency rather than N, against a
 * generation call that takes far longer — and the cap is
 * config.plan.maxMaterials, so N is small and bounded.
 */

import { config } from "../config/env.js";
import { buildContext } from "../materials/context-builder.js";
import { retrieveRelevantChunks } from "../materials/retrieval.service.js";
import * as materialRepository from "../materials/material.repository.js";

/**
 * Resolve requested material ids to materials this user actually owns.
 *
 * §10: "do not trust client-provided material ownership". The ids arrive from a
 * request body and are resolved here against the database with the owner in the
 * WHERE clause; anything that is not theirs, or does not exist, is simply absent
 * from the result. The two are indistinguishable on purpose — a caller must not
 * be able to learn that a material id is real by the shape of the rejection.
 *
 * Aliases are assigned in the caller's order, which findOwnedByIds preserves, so
 * the same request always produces the same alias for the same material.
 *
 * @param {Array<number>} materialIds
 * @param {number} userId
 * @returns {Promise<{materials: Array<{id: number, filename: string, alias: string}>,
 *   missing: number}>} `missing` is how many requested ids were not theirs
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
 * Retrieve and format the material extracts for one plan.
 *
 * Returns empty strings and empty collections for a plan with no materials,
 * which is a first-class case (§37) — the caller passes the result through
 * unchanged and the prompt simply omits the section.
 *
 * THROWS on a provider failure rather than degrading to a topic-only plan. A
 * learner who scoped a plan to three documents and silently received a plan
 * grounded in none of them has been given something other than what they asked
 * for, with nothing in the response to say so. The service turns this into the
 * same AI_UNAVAILABLE 500 the chat path uses.
 *
 * @param {object} input
 * @param {number} input.userId
 * @param {Array<{id: number, filename: string, alias: string}>} input.materials
 * @param {string} input.subject
 * @param {Array<string>} input.topics
 * @returns {Promise<{context: string, aliases: Set<string>,
 *   aliasToMaterialId: Map<string, number>, sourceCount: number}>}
 */
export async function buildMaterialBrief({ userId, materials, subject, topics }) {
  const aliases = new Set(materials.map((m) => m.alias));
  const aliasToMaterialId = new Map(materials.map((m) => [m.alias, m.id]));

  if (materials.length === 0) {
    return { context: "", aliases, aliasToMaterialId, sourceCount: 0 };
  }

  const query = retrievalQuery(subject, topics);

  const perMaterial = await Promise.all(
    materials.map(async (material) => {
      const { chunks } = await retrieveRelevantChunks({
        userId,
        materialId: material.id,
        question: query,
      });

      // The alias replaces the filename BEFORE the chunk reaches the context
      // builder, so the `Material:` line the model reads carries the label it is
      // told to reference. A new object rather than a mutation: the retrieval
      // result belongs to the retrieval service, and rewriting its fields in
      // place would make a shared module's output depend on who read it first.
      return chunks.map((chunk) => ({ ...chunk, filename: material.alias }));
    }),
  );

  const { context, sources } = buildContext(interleave(perMaterial), {
    // The plan budget, not the RAG one. A plan needs enough of each document to
    // know what it covers; the chat path needs enough to quote. See
    // config.plan.maxContextChars.
    maxChars: config.plan.maxContextChars,
  });

  return {
    context,
    aliases,
    aliasToMaterialId,
    sourceCount: sources.length,
  };
}

/**
 * The text the extracts are retrieved against.
 *
 * A plan has no question, so one is composed from what the learner did say. The
 * topics carry most of the signal; the subject is included because a plan with
 * no topics (§7 allows one) would otherwise have nothing to search with.
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
 * exhausting the first material's five chunks before reaching the second.
 *
 * Materials whose extracts do not fit are still named in the prompt's AVAILABLE
 * MATERIALS list. That is intended: the learner scoped the plan to them, so the
 * model may schedule time against them — it just may not claim to know what is
 * inside one it was shown no extract from, which is what prompt rule 6 forbids.
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
