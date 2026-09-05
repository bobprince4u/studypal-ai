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
 * Behaviour is steered per-request by the FAKE_GEMINI_MODE env var:
 *   "json"          → valid JSON object in the response text (happy path)
 *   "fenced"        → JSON wrapped in ```json fences (exercises the fallback)
 *   "prose"         → non-JSON prose (exercises the final fallback shape)
 *   "http-error"    → Gemini replies 500 (exercises the API error path)
 *   "network-error" → fetch itself rejects (exercises the transport error path)
 */

const GEMINI_HOST_MARKER = "googleapis.com";

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

const realFetch = globalThis.fetch;

globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));

  // Anything that is not a Gemini call goes to the real network untouched.
  if (!url.includes(GEMINI_HOST_MARKER)) {
    return realFetch(input, init);
  }

  const mode = process.env.FAKE_GEMINI_MODE || "json";

  if (mode === "network-error") {
    throw new TypeError("fetch failed");
  }

  if (mode === "http-error") {
    return new Response(
      JSON.stringify({
        error: {
          code: 500,
          message: "fake upstream failure",
          status: "INTERNAL",
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(JSON.stringify(geminiEnvelope(bodyForMode(mode))), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
