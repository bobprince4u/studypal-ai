/**
 * Vector validation and pgvector serialization.
 *
 * Lives in `utils/` rather than in `ai/` or `materials/` because both need it and
 * neither should import the other: the embedding service validates what the
 * provider returned, and the repositories serialize what goes into SQL. A copy
 * in each place would be two places for the dimension check to drift.
 *
 * Pure functions, no I/O, no config-dependent behaviour beyond the dimension
 * passed in — so every rule here is directly testable without a database or a
 * provider.
 */

/**
 * A pgvector literal for a validated embedding: `[0.1,-0.2,...]`.
 *
 * pgvector accepts this text form as a bind parameter — `$1::vector` with a
 * string — which is what makes vectors safe to pass through `pg` at all. The
 * alternative, interpolating numbers into the SQL text, is how a vector column
 * becomes an injection surface: the values originate from a provider response,
 * and "it's only numbers" is an assumption about a remote service's output
 * rather than a fact about it. Here the string is a *parameter*; PostgreSQL
 * parses it as a vector and nothing in it can be read as SQL.
 *
 * assertValidEmbedding() must have passed first. This function does not
 * re-validate, and JSON.stringify would happily produce `[null]` for a NaN.
 *
 * @param {number[]} embedding
 * @returns {string}
 */
export function toVectorLiteral(embedding) {
  // Manual join rather than JSON.stringify: stringify turns NaN and Infinity
  // into `null`, which pgvector rejects with a parse error that names neither
  // the row nor the reason. Any non-finite value should already have been caught
  // by assertValidEmbedding, and if one gets here it should look like the bug it
  // is rather than a null.
  return `[${embedding.join(",")}]`;
}

/**
 * Throw unless `embedding` is a usable vector of exactly `expectedDimensions`.
 *
 * §28 requires this before anything is persisted, and the reason is that the
 * failure it prevents is invisible. A truncated or malformed vector inserts
 * cleanly if it happens to have the right length, and then produces plausible
 * distances forever — a corpus that returns confident, wrong retrievals. There
 * is no later point at which that gets detected, so the check has to be here.
 *
 * NaN specifically: cosine distance to a NaN-containing vector is NaN, and
 * `ORDER BY` puts NaN *first* in PostgreSQL (it sorts NaN as larger than every
 * number, so ascending-by-distance would place it last, but a threshold
 * comparison against it is always false). One poisoned row would either shadow
 * every real result or silently disappear from them, depending on the query.
 * Neither is acceptable and neither raises an error on its own.
 *
 * @param {unknown} embedding
 * @param {number} expectedDimensions
 * @param {string} [subject] identifies the offender in the message, e.g. "chunk 4"
 * @returns {asserts embedding is number[]}
 */
export function assertValidEmbedding(embedding, expectedDimensions, subject = "embedding") {
  if (!Array.isArray(embedding)) {
    throw new Error(
      `${subject}: expected an array of numbers, got ${describe(embedding)}`,
    );
  }

  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `${subject}: expected ${expectedDimensions} dimensions, got ${embedding.length}`,
    );
  }

  // Index-carrying message: with 1536 values, "contains a NaN" is not enough to
  // act on, and logging the vector itself is not an option — it is derived from
  // a student's document.
  for (let i = 0; i < embedding.length; i += 1) {
    const value = embedding[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `${subject}: value at index ${i} is not a finite number (${describe(value)})`,
      );
    }
  }
}

/**
 * True when `embedding` is a usable vector — the non-throwing form.
 *
 * For the caller that wants to skip a bad row rather than abort a batch.
 */
export function isValidEmbedding(embedding, expectedDimensions) {
  try {
    assertValidEmbedding(embedding, expectedDimensions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scale a vector to unit length, so cosine similarity and inner product agree.
 *
 * REQUIRED for gemini-embedding-001 below 3072 dimensions: Google's own
 * documentation states that truncated Matryoshka output is not normalized and
 * that normalizing is the caller's responsibility. Skipping it does not break
 * cosine distance — pgvector divides by the magnitudes itself — but it makes the
 * stored data depend on which operator reads it, so a later switch to `<#>`
 * (inner product, cheaper) would quietly start ranking long vectors above
 * relevant ones. Normalizing once on write removes that trap permanently.
 *
 * A zero vector is returned unchanged rather than divided by zero. It is not a
 * meaningful embedding — pgvector cannot even index one for cosine, since every
 * cosine distance to it is undefined — but producing NaNs here would convert a
 * provider oddity into corrupt data, and the caller's dimension/finiteness check
 * is the right place for that judgement.
 *
 * @param {number[]} embedding
 * @returns {number[]}
 */
export function normalize(embedding) {
  let sumOfSquares = 0;
  for (const value of embedding) sumOfSquares += value * value;

  if (sumOfSquares === 0) return embedding;

  const magnitude = Math.sqrt(sumOfSquares);
  return embedding.map((value) => value / magnitude);
}

/** A short, safe description of an unexpected value for an error message. */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "string") {
    // Truncated: this may be provider output, which should not be pasted
    // wholesale into a log line.
    return `a string (${value.length} chars)`;
  }
  return typeof value;
}
