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
 * FOUR INDEPENDENT MODE SWITCHES
 * ------------------------------
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
 *   FAKE_PLAN_MODE       generation for POST /api/study-plans (SP-V2-005),
 *                        recognised by `durationMinutes` in its
 *                        responseJsonSchema — the same technique the chat path
 *                        uses, and for the same reason: one server process must
 *                        be able to serve /api/ask, /api/materials/chat and
 *                        /api/study-plans with the right shape for each.
 *     "valid"         → a plan sized to the brief the prompt states  (default)
 *     "long-tasks"    → every task exceeds the daily budget (§21 clamping)
 *     "overflow"      → far more content than the calendar holds (§22 dropping)
 *     "cite-material" → every task cites MATERIAL_1
 *     "invent-material" → tasks cite MATERIAL_99, which no prompt contains (§20)
 *     "prose"         → not JSON at all
 *     "empty-tasks"   → a well-formed plan with zero tasks (§19)
 *     "no-title"      → tasks present, plan title missing (§19)
 *     "bad-type"      → a taskType outside the four allowed (§19)
 *     "bad-duration"  → durationMinutes as the string "45 minutes" (§19)
 *     "too-many-tasks"→ more tasks than STUDYPAL_PLAN_MAX_TASKS (§19)
 *     "long-text"     → title and goal far over the column bounds (clamping)
 *     "retry-once"    → invalid on the first call, valid on the second, which is
 *                       the only way to observe §33's single controlled retry
 *
 *   FAKE_PLAN_MODE governs only the RESPONSE SHAPE, exactly like FAKE_CHAT_MODE:
 *   a plan test that needs the provider itself to fail sets FAKE_GEMINI_MODE.
 *   Setting FAKE_GEMINI_MODE=http-error and still receiving a 200 is what proves
 *   an endpoint did NOT call the generation API.
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

/** The plan title the study-plan modes return, so a test can assert on it. */
export const CANNED_PLAN_TITLE = "Focused Revision Plan";

/**
 * Is this generation call the study-plan one?
 *
 * Same technique as isMaterialChatRequest, and the marker is again a field name
 * unique to one schema: `durationMinutes` appears in
 * STUDY_PLAN_RESPONSE_SCHEMA and nowhere else. /api/ask sends no
 * responseJsonSchema at all, and the chat schema names `sourceIndexes`, so the
 * three generation paths are distinguishable without any test having to remember
 * to set a flag.
 */
function isStudyPlanRequest(init) {
  return typeof init?.body === "string" && init.body.includes("durationMinutes");
}

/**
 * The brief the prompt states, read back out of it.
 *
 * The fake sizes its response to what it was actually asked for, rather than to
 * constants that would silently stop matching when a test changes a learner's
 * daily minutes. Both numbers are emitted by formatLearnerGoals in
 * src/ai/prompts/study-plan.prompt.js.
 *
 * The fallbacks are deliberately small: a prompt that did not state a brief is a
 * bug in the prompt, and a fake that quietly invented a large one would hide it.
 */
function planBrief(body) {
  const text = promptText(body);
  const minutes = Number(text.match(/Time available per study day: (\d+)/)?.[1]);
  const sessions = Number(
    text.match(/Number of study sessions available before the exam: (\d+)/)?.[1],
  );
  return {
    dailyMinutes: Number.isInteger(minutes) && minutes > 0 ? minutes : 60,
    sessionCount: Number.isInteger(sessions) && sessions > 0 ? sessions : 1,
  };
}

/** Does the prompt carry an AVAILABLE MATERIALS block naming MATERIAL_1? */
function promptHasMaterials(body) {
  return promptText(body).includes("MATERIAL_1");
}

function planTask(index, { durationMinutes, material }) {
  return {
    title: `Session ${index + 1}: core concepts`,
    description:
      "Work through the key ideas, then summarise them in your own words.",
    topic: "Photosynthesis",
    // Cycled rather than fixed so a single plan exercises more than one branch
    // of the task_type CHECK constraint.
    taskType: ["study", "review", "practice", "recap"][index % 4],
    durationMinutes,
    ...(material ? { material } : {}),
  };
}

/**
 * How many calls this process has served, keyed by mode.
 *
 * Module-level state is safe here because each test starts its own server child
 * process (see startServer), so the counter begins at zero for every test rather
 * than leaking across them. "retry-once" is the only mode that reads it.
 */
const planCallCounts = new Map();

function planBodyForMode(mode, requestBody) {
  const { dailyMinutes, sessionCount } = planBrief(requestBody);
  const material = promptHasMaterials(requestBody) ? "MATERIAL_1" : null;

  // Two tasks per session day, each half the budget, so a valid plan exercises
  // multi-task days and `position` ordering rather than only one task per date.
  // Capped so a long horizon cannot push a happy-path plan past maxTasks — that
  // is what "too-many-tasks" is for, and it should fail for that reason alone.
  const perDay = 2;
  const taskCount = Math.min(sessionCount * perDay, 100);
  const duration = Math.max(1, Math.floor(dailyMinutes / perDay));

  const valid = {
    title: CANNED_PLAN_TITLE,
    goal: "Build a working understanding of the subject before the exam.",
    tasks: Array.from({ length: taskCount }, (_, i) =>
      planTask(i, { durationMinutes: duration, material }),
    ),
  };

  switch (mode) {
    case "long-tasks":
      // §21. Every task is one minute over the whole daily budget, so the
      // normalizer must clamp each one and give each its own day.
      return JSON.stringify({
        ...valid,
        tasks: Array.from({ length: taskCount }, (_, i) =>
          planTask(i, { durationMinutes: dailyMinutes + 1, material }),
        ),
      });

    case "overflow":
      // §22. Ten times the content the calendar can hold, so the tail must be
      // dropped rather than scheduled past the exam date.
      return JSON.stringify({
        ...valid,
        tasks: Array.from({ length: Math.min(sessionCount * 10 + 10, 190) }, (_, i) =>
          planTask(i, { durationMinutes: dailyMinutes, material }),
        ),
      });

    case "cite-material":
      return JSON.stringify({
        ...valid,
        tasks: valid.tasks.map((task) => ({ ...task, material: "MATERIAL_1" })),
      });

    case "invent-material":
      // §20. An alias no prompt has ever contained. The reference must be
      // dropped and the task kept.
      return JSON.stringify({
        ...valid,
        tasks: valid.tasks.map((task) => ({ ...task, material: "MATERIAL_99" })),
      });

    case "prose":
      return "Here is a lovely study plan, described in prose. No JSON at all.";

    case "empty-tasks":
      return JSON.stringify({ ...valid, tasks: [] });

    case "no-title":
      return JSON.stringify({ ...valid, title: "   " });

    case "bad-type":
      return JSON.stringify({
        ...valid,
        tasks: [{ ...valid.tasks[0], taskType: "exam" }],
      });

    case "bad-duration":
      return JSON.stringify({
        ...valid,
        tasks: [{ ...valid.tasks[0], durationMinutes: "45 minutes" }],
      });

    case "too-many-tasks":
      return JSON.stringify({
        ...valid,
        tasks: Array.from({ length: 500 }, (_, i) =>
          planTask(i, { durationMinutes: 10, material: null }),
        ),
      });

    case "long-text":
      return JSON.stringify({
        ...valid,
        title: "T".repeat(600),
        goal: "G".repeat(5000),
        tasks: valid.tasks.map((task) => ({
          ...task,
          title: "S".repeat(600),
          description: "D".repeat(5000),
          topic: "P".repeat(600),
        })),
      });

    case "retry-once": {
      // §33. The first call is refused by the validator, the second succeeds —
      // so a test can assert both that one retry happens and that it produces a
      // single plan rather than two.
      const seen = (planCallCounts.get("retry-once") ?? 0) + 1;
      planCallCounts.set("retry-once", seen);
      return seen === 1
        ? "not json at all, on purpose"
        : JSON.stringify(valid);
    }

    case "valid":
    default:
      return JSON.stringify(valid);
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

  // Checked before the chat marker only for readability; the two markers are
  // fields of different schemas and cannot both be present.
  if (isStudyPlanRequest(init)) {
    const planMode = process.env.FAKE_PLAN_MODE || "valid";
    return jsonResponse(
      geminiEnvelope(planBodyForMode(planMode, parseBody(init))),
    );
  }

  if (isMaterialChatRequest(init)) {
    const chatMode = process.env.FAKE_CHAT_MODE || "grounded";
    return jsonResponse(
      geminiEnvelope(chatBodyForMode(chatMode, parseBody(init))),
    );
  }

  return jsonResponse(geminiEnvelope(bodyForMode(mode)));
};
