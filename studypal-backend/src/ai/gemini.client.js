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
 *
 * SP-V2-004 added `embedContents` here rather than in a second client, so this
 * remains the single place the SDK is imported and the single place an API key
 * is read. Generation and embedding are different models and different response
 * shapes but the same credential, the same transport and the same failure modes,
 * and two clients would mean two of everything — including two places to add a
 * proxy, a retry or a timeout.
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

/** The abort signal for one request, or undefined when timeouts are off. */
function abortSignal() {
  return config.ai.timeoutMs > 0
    ? AbortSignal.timeout(config.ai.timeoutMs)
    : undefined;
}

/**
 * Send prepared `contents` to Gemini and return the raw trimmed text.
 *
 * Rejects rather than translating failures: mapping provider errors onto HTTP
 * status codes and client-safe messages is the service layer's job.
 *
 * @param {Array<object>} contents @google/genai `contents` array
 * @param {object} [options]
 * @param {object} [options.responseJsonSchema] JSON Schema the reply must match
 * @returns {Promise<string>} raw model text, trimmed
 */
export async function generateJsonContent(contents, options = {}) {
  const request = {
    model: config.ai.model,
    contents,
    config: { responseMimeType: "application/json" },
  };

  // Structured output, when the caller has a schema. Used by the material chat
  // path (§23) so the model returns `{answer, sourceIndexes}` rather than prose
  // that has to be pattern-matched; /api/ask passes nothing and is byte-for-byte
  // unchanged. Constrained decoding is the provider enforcing the shape, which
  // is stronger than asking for it in the prompt — but not a guarantee, so the
  // caller validates anyway.
  if (options.responseJsonSchema) {
    request.config.responseJsonSchema = options.responseJsonSchema;
  }

  // Opt-in only; defaults to no timeout, matching the previous behaviour.
  const signal = abortSignal();
  if (signal) request.config.abortSignal = signal;

  const response = await getClient().models.generateContent(request);
  return response.text.trim();
}

/**
 * Embed one or more texts and return their raw vectors, in input order.
 *
 * Returns exactly one vector per input, and the caller depends on that: the
 * embedding service maps results back to chunks positionally. The SDK documents
 * the response as being "in the same order as provided in the batch request",
 * and the count is checked here so a provider that ever stops honouring it fails
 * loudly instead of shifting every chunk's vector by one — a corruption that
 * would produce plausible distances and no error at all.
 *
 * `taskType` is what makes retrieval work rather than merely run:
 * RETRIEVAL_DOCUMENT for stored chunks and RETRIEVAL_QUERY for a question, so a
 * question lands near the passage that answers it instead of near other
 * questions. It is a documented feature of gemini-embedding-001 and one of the
 * reasons config.rag.embeddingModel pins that model.
 *
 * Vectors come back RAW: not normalized, not validated. Both belong to
 * src/ai/embedding.service.js — this module is transport, and a transport that
 * silently rescales its payload is a transport you cannot debug through.
 *
 * @param {object} params
 * @param {string[]} params.texts non-empty; length must be within the batch limit
 * @param {"RETRIEVAL_DOCUMENT"|"RETRIEVAL_QUERY"} params.taskType
 * @returns {Promise<number[][]>} one vector per input, same order
 */
export async function embedContents({ texts, taskType }) {
  const request = {
    model: config.rag.embeddingModel,
    contents: texts,
    config: {
      taskType,
      // Requested explicitly rather than left to the model's 3072 default,
      // because the column is vector(1536) and a default-width response would
      // fail every insert. See config.rag.embeddingDimensions.
      outputDimensionality: config.rag.embeddingDimensions,
    },
  };

  const signal = abortSignal();
  if (signal) request.config.abortSignal = signal;

  const response = await getClient().models.embedContent(request);
  const embeddings = response?.embeddings;

  if (!Array.isArray(embeddings)) {
    throw new Error(
      `Gemini embedding response had no embeddings array (got ${typeof embeddings})`,
    );
  }

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs. ` +
        "Vectors are matched to chunks by position, so a count mismatch cannot be " +
        "reconciled safely.",
    );
  }

  return embeddings.map((embedding) => embedding?.values);
}

/** Test seam: drop the memoised client so config changes take effect. */
export function resetClient() {
  client = null;
}

