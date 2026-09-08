/**
 * Fake Gemini preload module.
 *
 * Loaded with `node --import ./tests/helpers/fake-gemini.mjs server.js` so that
 * it patches `globalThis.fetch` BEFORE the application (and the @google/genai
 * SDK) is evaluated.
 *
 * Why a preload instead of a module mock?
 *   The whole point of the baseline suite is to exercise the *unmodified*
 *   server as a black box. @google/genai issues its requests through the bare
 *   global `fetch`, so intercepting that global is the only seam that works
 *   against both the original monolithic server.js and the refactored one —
 *   which is what makes a true before/after equivalence check possible.
 *
 * SP-V2-004 added embeddings, and with them a second Google endpoint to answer.
 * The dispatch is on the URL, because that is what actually distinguishes them:
 *
 *   …/models/{model}:generateContent      → a generation envelope
 *   …/models/{model}:batchEmbedContents   → an embeddings envelope
 *
 * `:batchEmbedContents` is not a guess. @google/genai's `models.embedContent`
 * maps to that path for API-key (mldev) clients — see embedContentInternal in
 * node_modules/@google/genai — and sends `{requests: [{content, taskType,
 * outputDimensionality, model}, …]}`, expecting `{embeddings: [{values}, …]}`
 * back in input order. This file reproduces exactly that shape, so the real
 * client, the real request construction and the real response parsing are all
 * exercised; only the network is fake.
 *
 * THREE INDEPENDENT MODE SWITCHES
 * -------------------------------
 * One variable per failure surface, because a test needs to break one thing at a
 * time. `FAKE_GEMINI_MODE=http-error` used to be the only switch; if it also
 * governed embeddings, a test of "the AI is down" would additionally leave every
 * material unindexed, and the assertion would no longer be about what it says.
 *
 *   FAKE_GEMINI_MODE     generation (POST /api/ask). Unchanged meanings:
 *     "json"          → valid JSON object in the response text (happy path)
 *     "fenced"        → JSON wrapped in ```json fences (exercises the fallback)
 *     "prose"         → non-JSON prose (exercises the final fallback shape)
 *     "http-error"    → Gemini replies 500 (exercises the API error path)
 *     "network-error" → fetch itself rejects (exercises the transport error path)
 *
 *   FAKE_CHAT_MODE       generation for POST /api/materials/chat, which is
 *                        recognised by its responseJsonSchema rather than by a
 *                        flag the test has to remember to set:
 *     "grounded"      → {answer, sourceIndexes: [1]}                  (default)
 *     "all-sources"   → cites every source the prompt contained
 *     "no-sources"    → an answer with sourceIndexes: []
 *     "invalid-index" → sourceIndexes: [99], which no prompt ever contains
 *     "echo-prompt"   → answers with the prompt it received, so an injection
 *                       test can inspect the boundary the server built
 *     "prose"         → not JSON at all (exercises the parse failure path)
 *
 *   FAKE_CHAT_MODE governs only the RESPONSE SHAPE. A chat test that needs the
 *   provider to fail sets FAKE_GEMINI_MODE=http-error or network-error, which is
 *   checked first and applies to both generation paths — the transport does not
 *   know which endpoint asked.
 *
 *   FAKE_EMBEDDING_MODE  embeddings:
 *     "ok"             → deterministic fixture vectors               (default)
 *     "http-error"     → 500 from the embedding endpoint
 *     "network-error"  → fetch rejects
 *     "malformed"      → 200 with no embeddings array
 *     "wrong-dimension"→ vectors of the wrong width
 *     "nan"            → a vector containing NaN
 *     "count-mismatch" → fewer vectors than inputs
 *
 * The vectors come from tests/fixtures/vectors.mjs, whose orthonormal-basis design
 * is what makes retrieval ordering predictable on paper (§35).
 */

import { fakeEmbedding, FIXTURE_DIMENSIONS } from "../fixtures/vectors.mjs";

const GEMINI_HOST_MARKER = "googleapis.com";
const EMBEDDING_PATH_MARKER = /:(?:batchEmbedContents|embedContent)/;

export const CANNED_ANSWER = {
  explanation:
    "Photosynthesis is how green plants make their own food using sunlight.",
  topic: "Photosynthesis",
  practice_questions: [
    { question: "What gas do plants take in?", answer: "Carbon dioxide." },
    { question: "Where does photosynthesis happen?", answer: "In chloroplasts." },
  ],
  encouragement: "You are doing great — keep it up!",
};

/** The answer text the material-chat modes return, so a test can assert on it. */
export const CANNED_CHAT_ANSWER =
  "According to your material, photosynthesis converts light into chemical energy.";

function geminiEnvelope(text) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 42,
      candidatesTokenCount: 99,
      totalTokenCount: 141,
    },
    modelVersion: "fake-gemini-for-tests",
  };
}

function bodyForMode(mode) {
  switch (mode) {
    case "fenced":
      return "```json\n" + JSON.stringify(CANNED_ANSWER) + "\n```";
    case "prose":
      return "Photosynthesis is how plants make food. No JSON here at all.";
    case "json":
    default:
      return JSON.stringify(CANNED_ANSWER);
  }
}

/** Parse a request body, or {} — a fake must not crash on a shape it did not expect. */
function parseBody(init) {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body) : {};
  } catch {
    return {};
  }
}

/**
 * Is this generation call the material-chat one?
 *
 * Detected from the request rather than from an env var so that a single test
 * process can exercise /api/ask and /api/materials/chat against one server and
 * get the right response shape for each — which matters, because §26 requires
 * proving the two endpoints did not become the same thing. The marker is the
 * `sourceIndexes` property of MATERIAL_CHAT_RESPONSE_SCHEMA: only the chat path
 * sends a responseJsonSchema, and only that schema names that field.
 */
function isMaterialChatRequest(init) {
  return typeof init?.body === "string" && init.body.includes("sourceIndexes");
}

/**
 * How many `[Source N]` blocks the prompt contains.
 *
 * Lets "all-sources" cite exactly what it was given, so a source-mapping test can
 * assert the full round trip without hard-coding a count the fixture might change.
 */
function countSources(body) {
  const text = JSON.stringify(body?.contents ?? "");
  return new Set(text.match(/\[Source \d+\]/g) ?? []).size;
}

/** The prompt text as the server assembled it, for the injection-boundary test. */
function promptText(body) {
  const parts = [];
  for (const content of body?.contents ?? []) {
    for (const part of content?.parts ?? []) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function chatBodyForMode(mode, requestBody) {
  const sourceCount = countSources(requestBody);
  switch (mode) {
    case "all-sources":
      return JSON.stringify({
        answer: CANNED_CHAT_ANSWER,
        sourceIndexes: Array.from({ length: sourceCount }, (_, i) => i + 1),
      });
    case "no-sources":
      return JSON.stringify({ answer: CANNED_CHAT_ANSWER, sourceIndexes: [] });
    case "invalid-index":
      // §37: the model names a source the prompt never contained. The server must
      // drop it rather than invent metadata for it.
      return JSON.stringify({ answer: CANNED_CHAT_ANSWER, sourceIndexes: [99] });
    case "echo-prompt":
      // §38: hands the assembled prompt back so a test can inspect the boundary
      // between application instructions, the question and untrusted material.
      return JSON.stringify({
        answer: promptText(requestBody),
        sourceIndexes: [1],
      });
    case "prose":
      return "I cannot produce JSON today. Here is some prose instead.";
    case "grounded":
    default:
      return JSON.stringify({
        answer: CANNED_CHAT_ANSWER,
        sourceIndexes: sourceCount > 0 ? [1] : [],
      });
  }
}

/**
 * The embeddings envelope for a `:batchEmbedContents` request.
 *
 * One vector per `requests[]` entry, in input order — the contract
 * src/ai/gemini.client.js checks and src/materials/material-indexing.service.js
 * relies on positionally. The failure modes deliberately violate exactly one part
 * of that contract each, so a test can name which guard it is exercising.
 */
function embeddingEnvelope(body, mode) {
  const requests = Array.isArray(body?.requests) ? body.requests : [];
  const texts = requests.map((request) =>
    (request?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join(" "),
  );

  if (mode === "malformed") {
    // A 200 with a plausible-looking body and no vectors: the shape a proxy or a
    // changed API version produces, and the one §34 asks to be handled.
    return { metadata: { note: "no embeddings key at all" } };
  }

  if (mode === "count-mismatch") {
    return {
      embeddings: texts.slice(0, Math.max(0, texts.length - 1)).map((text) => ({
        values: fakeEmbedding(text),
      })),
    };
  }

  return {
    embeddings: texts.map((text) => {
      if (mode === "wrong-dimension") {
        return { values: fakeEmbedding(text).slice(0, 8) };
      }
      if (mode === "nan") {
        const values = fakeEmbedding(text);
        values[FIXTURE_DIMENSIONS - 2] = Number.NaN;
        return { values };
      }
      return { values: fakeEmbedding(text) };
    }),
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The 500 body Gemini itself returns, so error handling sees a realistic shape. */
function upstreamError() {
  return jsonResponse(
    { error: { code: 500, message: "fake upstream failure", status: "INTERNAL" } },
    500,
  );
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));

  // Anything that is not a Gemini call goes to the real network untouched.
  if (!url.includes(GEMINI_HOST_MARKER)) {
    return realFetch(input, init);
  }

  // ── embeddings ──
  if (EMBEDDING_PATH_MARKER.test(url)) {
    const mode = process.env.FAKE_EMBEDDING_MODE || "ok";
    if (mode === "network-error") throw new TypeError("fetch failed");
    if (mode === "http-error") return upstreamError();
    return jsonResponse(embeddingEnvelope(parseBody(init), mode));
  }

  // ── generation ──
  const mode = process.env.FAKE_GEMINI_MODE || "json";

  if (mode === "network-error") {
    throw new TypeError("fetch failed");
  }

  if (mode === "http-error") {
    return upstreamError();
  }

  if (isMaterialChatRequest(init)) {
    const chatMode = process.env.FAKE_CHAT_MODE || "grounded";
    return jsonResponse(
      geminiEnvelope(chatBodyForMode(chatMode, parseBody(init))),
    );
  }

  return jsonResponse(geminiEnvelope(bodyForMode(mode)));
};
