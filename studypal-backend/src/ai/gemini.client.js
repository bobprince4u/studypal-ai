/**
 * Gemini transport.
 *
 * The ONLY module in the codebase that imports @google/genai or knows what
 * `generateContent` is. Everything above it talks to src/services/ai.service.js
 * and receives plain text back, which is what makes swapping or adding a
 * provider later a change confined to this directory.
 *
 * Extracted from server.js:13 and 112-118 with no behavioural change: same
 * model, same `responseMimeType: "application/json"`, same `.text.trim()`.
 */

import { GoogleGenAI } from "@google/genai";

import { config } from "../config/env.js";

let client = null;

/**
 * Constructed lazily so that importing the app does not require a key. The
 * pre-refactor server built the client at import time; deferring it means
 * GET /health, history and progress work on a machine with no GEMINI_API_KEY.
 */
function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.ai.apiKey });
  }
  return client;
}

/**
 * Send prepared `contents` to Gemini and return the raw trimmed text.
 *
 * Rejects rather than translating failures: mapping provider errors onto HTTP
 * status codes and client-safe messages is the service layer's job.
 *
 * @param {Array<object>} contents @google/genai `contents` array
 * @returns {Promise<string>} raw model text, trimmed
 */
export async function generateJsonContent(contents) {
  const request = {
    model: config.ai.model,
    contents,
    config: { responseMimeType: "application/json" },
  };

  // Opt-in only; defaults to no timeout, matching the previous behaviour.
  if (config.ai.timeoutMs > 0) {
    request.config.abortSignal = AbortSignal.timeout(config.ai.timeoutMs);
  }

  const response = await getClient().models.generateContent(request);
  return response.text.trim();
}

/** Test seam: drop the memoised client so config changes take effect. */
export function resetClient() {
  client = null;
}
