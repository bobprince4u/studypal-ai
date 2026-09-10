/**
 * Material chat: a question about a student's own documents, answered from them.
 *
 * The orchestrator for the whole RAG path, and the module that owns the one
 * decision the feature exists to get right: WHETHER TO CALL GEMINI AT ALL.
 *
 * §21 and §33 draw a three-way distinction that this file keeps distinct end to
 * end, because collapsing any two of them is how a RAG system starts lying:
 *
 *   (a) evidence exists      → build context, call the model, answer from it
 *   (b) no relevant evidence → DO NOT call the model; return "not covered"
 *   (c) the provider failed  → a 500 with a safe message; NOT "not covered"
 *
 * (b) is the one that takes discipline. The tempting shortcut is to call the
 * model with an empty context and let it say it does not know — but a model asked
 * a question with no evidence answers it from general knowledge more often than
 * not, and it answers inside an endpoint whose entire promise is "from your
 * materials". So the call is not made: there is nothing to ground an answer in,
 * and a request that cannot produce a grounded answer must not produce an answer.
 * It also costs no quota, which is a pleasant side effect and not the reason.
 *
 * (c) matters just as much in the other direction. A provider outage reported as
 * "your materials do not cover this" tells the student something false about their
 * own documents, and would have them re-upload a file that was never the problem.
 * Retrieval failures and generation failures both throw from here.
 *
 * NEVER TOUCHES: `req`, `res`, SQL, the filesystem, or the Google SDK. Ownership
 * is resolved through the existing user repository and enforced in the retrieval
 * repository's WHERE clause.
 */

import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import * as users from "../repositories/user.repository.js";
import { internal, notFound } from "../utils/app-error.js";
import { generateJsonContent } from "../ai/gemini.client.js";
import {
  MATERIAL_CHAT_RESPONSE_SCHEMA,
  buildMaterialChatPrompt,
} from "../ai/prompts/material-chat.prompt.js";
import * as materialRepository from "./material.repository.js";
import { retrieveRelevantChunks } from "./retrieval.service.js";
import { buildContext } from "./context-builder.js";
import { mapSources } from "./source-mapper.js";

/**
 * The answer given when retrieval found nothing above the threshold.
 *
 * Fixed server-side text, not model output — there is no model call on this path.
 * It says what is true (nothing in the indexed materials matched) and what to do
 * about it, and it does not speculate about why. "Not yet finished processing" is
 * mentioned because it is a real and common cause: a material whose indexing
 * failed contributes no chunks, and the student's next question would otherwise
 * be "but I uploaded it".
 */
const NO_EVIDENCE_ANSWER =
  "I could not find anything about that in your uploaded study materials. " +
  "Try rewording the question, or check that the material you have in mind " +
  "finished uploading and is ready for search.";

/** Condition (b): the search ran and found nothing to ground an answer in. */
function noEvidence() {
  return { answer: NO_EVIDENCE_ANSWER, sources: [], grounded: false };
}

/**
 * Answer a question from the student's own materials.
 *
 * @param {object} input
 * @param {string} input.username unauthenticated claim; see the S1 note below
 * @param {string} input.question already validated for presence and length
 * @param {number|null} [input.materialId] optional single-material scope
 * @param {number} [input.topK] a hint, clamped server-side
 * @returns {Promise<{answer: string, sources: Array<object>, grounded: boolean}>}
 * @throws {AppError} 404 when the username or the scoped material is unknown or
 *   not theirs; 500 when a provider call fails
 */
export async function answerFromMaterials({
  username,
  question,
  materialId = null,
  topK,
}) {
  // Resolved server-side from the username, exactly as every other material
  // endpoint does. The request never supplies a user id — §16's "do not trust
  // client-provided user IDs" is kept by there being no parameter for one.
  //
  // A read path, so it does not create the user (unlike upload). An unknown
  // username is treated as a student with nothing uploaded — NOT as a 404 —
  // whenever the request does not name a material, which is the same choice
  // listMaterials makes: "this user has nothing" and "this user does not exist"
  // are the same answer to a client that cannot authenticate anyway. Two
  // consequences make it the right one here. It is true: there is no indexed
  // chunk behind that username, which is exactly what the no-evidence answer
  // says. And it removes an oracle — 404ing an unknown username while answering
  // 200 for a known one with no uploads would make the status code report whether
  // a username exists, which is precisely what a 404 was supposed to avoid.
  //
  // A request that DOES name a materialId keeps the 404, below: the caller named
  // an id, and "unknown, or not yours" is one answer for both, matching
  // getMaterial. That is where the 404 belongs, and it means only that.
  //
  // THE LIMITATION, STATED WHERE IT APPLIES: `username` is a claim, not a
  // credential. Anyone who knows a student's username can ask questions of that
  // student's documents through this endpoint and read passages of them back in
  // the answer. The isolation below is real — student A cannot reach student B's
  // chunks — but it isolates *claimed* identities. That is S1 in
  // docs/security-baseline.md, unchanged by this ticket (§16: do not implement
  // authentication here), and it is why this endpoint is not fit for real
  // student data yet.
  const userId = await users.findIdByUsername(username);
  if (userId === undefined) {
    if (materialId !== null) throw notFoundMaterial();
    logger.info("material chat: unknown username, answering as an empty corpus");
    return noEvidence();
  }

  // Checked BEFORE retrieval when the request scopes to one material, so a
  // request naming someone else's material gets a 404 rather than a successful
  // "nothing found" — the latter would be indistinguishable from an empty
  // material of their own and would confirm nothing, but it would also quietly
  // accept an id the caller has no business naming. Retrieval's SQL enforces
  // ownership again regardless; this check exists for the error message, not for
  // the security, which is why it is safe that it happens first.
  if (materialId !== null) {
    const owned = await materialRepository.findOwnedById(materialId, userId);
    if (!owned) throw notFoundMaterial();
  }

  let retrieval;
  try {
    retrieval = await retrieveRelevantChunks({
      userId,
      materialId,
      question,
      topK,
    });
  } catch (err) {
    // Embedding the question failed. This is condition (c), and it must not
    // become (b): the student's materials may well cover the question and we
    // simply could not look. The provider's message can carry request URLs and
    // quota detail, so it is logged and never forwarded.
    logger.error(`material chat: query embedding failed: ${err.message}`);
    throw internal("AI request failed", { cause: err, code: "AI_UNAVAILABLE" });
  }

  if (retrieval.chunks.length === 0) {
    // CONDITION (b). Gemini is not called — there is no line below this that
    // could call it on this path, which is the property tests/materials/chat
    // asserts by counting provider requests.
    logger.info(
      `material chat: no chunks above ${retrieval.threshold} similarity for user ${userId}` +
        (materialId === null ? "" : ` in material ${materialId}`),
    );
    return noEvidence();
  }

  // Bounded here, before anything is sent (§18). `sources` is exactly what the
  // prompt will contain, in prompt order, and it is what the model's source
  // numbers are resolved against — so a chunk dropped by the budget cannot be
  // cited, because it is not in the list the numbering came from.
  const { context, sources, usedChars, droppedChunks } = buildContext(
    retrieval.chunks,
  );

  if (droppedChunks > 0) {
    logger.debug(
      `material chat: context budget (${config.rag.maxContextChars} chars) dropped ` +
        `${droppedChunks} of ${retrieval.chunks.length} retrieved chunks`,
    );
  }

  const prompt = buildMaterialChatPrompt({ question, context });

  let raw;
  try {
    raw = await generateJsonContent(
      [{ role: "user", parts: [{ text: prompt }] }],
      { responseJsonSchema: MATERIAL_CHAT_RESPONSE_SCHEMA },
    );
  } catch (err) {
    // CONDITION (c) again, for generation. Same treatment: a safe 500, the real
    // cause logged. Note what is NOT logged — `prompt` contains retrieved
    // passages of the student's document, and §32 forbids logging retrieved
    // material by default. The chunk count is diagnostic; the text is not ours to
    // put in a log file.
    logger.error(
      `material chat: generation failed with ${sources.length} sources ` +
        `(${usedChars} context chars): ${err.message}`,
    );
    throw internal("AI request failed", { cause: err, code: "AI_UNAVAILABLE" });
  }

  const parsed = parseChatResponse(raw);

  if (parsed === null) {
    // The model returned something unparseable despite the schema. This is a
    // provider-side failure, not an absence of evidence, so it is (c) — the same
    // 500 as an outage. Deliberately NOT the /api/ask treatment, which surfaces
    // unparseable output as the answer text (see ai.service.js parseAnswer):
    // there, raw prose is still a usable answer to a general question; here it
    // would be ungrounded text presented by an endpoint that promises grounding,
    // with no way to attach honest sources to it.
    logger.error(
      "material chat: model response could not be parsed as the required JSON shape",
    );
    throw internal("AI request failed", { code: "AI_UNAVAILABLE" });
  }

  // The model named which sources it used; the backend decides what those names
  // mean. Every field of every citation below is read out of `sources`, which
  // came from the database — see source-mapper.js for why nothing else is safe.
  const mapped = mapSources(parsed.sourceIndexes, sources);

  return {
    answer: parsed.answer,
    sources: mapped,
    // A grounded answer is one built from retrieved context, which this is —
    // regardless of how many sources the model chose to credit. An answer with
    // an empty `sources` array here means the model could not attribute its
    // answer, not that it had no evidence.
    grounded: true,
  };
}

/**
 * Parse and validate the model's JSON, or null if it is unusable.
 *
 * The response is constrained by `responseJsonSchema`, so this should always
 * succeed — which is exactly why it is checked. Constrained decoding is the
 * provider enforcing a shape, and a provider is a remote service that can change,
 * degrade, or return an error envelope where a JSON object was expected. Trusting
 * the schema and calling `parsed.answer.trim()` would turn that into a
 * TypeError inside a request handler.
 *
 * `sourceIndexes` is not validated beyond being an array here; every value in it
 * is checked individually by mapSources, which is where being out of range or the
 * wrong type has a defined consequence.
 *
 * @param {string} raw
 * @returns {{answer: string, sourceIndexes: unknown[]} | null}
 */
function parseChatResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  // A non-empty answer string is the one thing this endpoint cannot substitute
  // for. An empty or missing `answer` is a failed generation, not an answer of
  // length zero, and returning "" to the client would render as a blank reply
  // with sources attached to nothing.
  if (typeof parsed.answer !== "string" || parsed.answer.trim() === "") {
    return null;
  }

  return {
    answer: parsed.answer.trim(),
    sourceIndexes: Array.isArray(parsed.sourceIndexes) ? parsed.sourceIndexes : [],
  };
}

/**
 * The 404 every ownership failure produces.
 *
 * Same message and same reasoning as material.service.js: one answer for "no such
 * user", "no such material" and "someone else's material", because
 * distinguishing them would tell an unauthenticated caller which ids and
 * usernames are real.
 */
function notFoundMaterial() {
  return notFound("Material not found.");
}
