# Study Material Processing

> **Status.** Added by **SP-V2-003**. This describes document *ingestion*: upload,
> validation, storage, text extraction, normalization, chunking and persistence.
>
> **Embeddings, pgvector, semantic search and RAG are intentionally deferred to
> SP-V2-004.** Nothing in this pipeline calls Gemini or any other model —
> processing is deterministic parsing, not interpretation. §15 of this document
> describes where the next iteration attaches.

The pipeline, end to end:

```
POST /api/materials
   │
   ├─ 1. validate      extension + client MIME type + magic bytes must agree
   ├─ 2. resolve user  username → users.id (created on demand)
   ├─ 3. store         bytes → <storage root>/<generated key>
   ├─ 4. insert row    materials, status = 'uploaded'
   └─ 5. process       status = 'processing'
            ├─ read      the one read of the file
            ├─ extract   PDF → per-page text; TXT → one NULL-numbered page
            ├─ normalize deterministic whitespace/control-character cleanup
            ├─ gate      no meaningful text ⇒ 'failed', never an empty 'ready'
            ├─ chunk     1800 characters, 250 overlap, 0-based, ordered
            └─ persist   chunks + status = 'ready', in ONE transaction
```

Everything is **synchronous**: the POST returns after processing has finished, so
the response already carries the final `status` and `chunkCount`. §30 is explicit
that no queue, worker or job table belongs in this iteration, and at a 10 MB cap
the honest cost is a slower upload response rather than a lost document.

---

## 1. Supported formats

| Extension | Stored `mime_type` | Client `Content-Type` accepted | Page numbers |
| --- | --- | --- | --- |
| `.pdf` | `application/pdf` | `application/pdf`, `application/x-pdf`, `application/octet-stream`, or absent | **Yes** — from the parser |
| `.txt` | `text/plain` | `text/plain`, `text/markdown`, `application/octet-stream`, or absent | No — always `NULL` |

Anything else is a `415`. Two formats is the whole list: §8 asks for PDF and
plain text, and a format nothing can extract is worse than a format that is
refused.

**Neither the extension nor the `Content-Type` is trusted on its own** (§8). Both
are client-controlled, and browsers derive the second from the first, so agreeing
with each other proves nothing. `src/materials/file-validation.js` therefore adds
a third input the client does not control — the file's first bytes:

- **PDF is identified positively.** The file must begin with `%PDF-`. A `.pdf`
  that does not is a `415`, not a material that reaches `failed`.
- **Plain text can only be ruled out.** Text has no signature; that is what makes
  it plain. So the test is inverted: a `.txt` whose content begins with a known
  binary signature (PDF, ZIP/`docx`, ELF, PNG, JPEG, GIF, gzip, legacy OLE, RTF,
  `MZ`) is rejected, and one that begins with prose is accepted because nothing
  contradicts the claim. A file whose first 8 KB is more than 1% NUL bytes (with a
  floor of 4) is also rejected as binary — a *density* test, not a presence test,
  because a handful of NULs turns up in genuine text exports and normalization
  strips them (§7 step 3).

**The type the backend RETURNS is the one derived from the content**, and that is
what `materials.mime_type` records. The client's claim never reaches the database.

This is deliberately not a virus scanner and cannot be one. The upload path's real
safety comes from what the backend never does with the bytes: never executes them,
never passes them to a shell, never uses the filename as a path, and only ever
hands them to a PDF parser or a UTF-8 decoder (§21's "no executable file
handling").

---

## 2. The upload flow

The order of the five steps in `uploadMaterial()`
([`src/materials/material.service.js`](../src/materials/material.service.js)) is
chosen so that no failure can leave a state a client would be misled by.

| Step | If it fails |
| --- | --- |
| 1. Validate the bytes | `400`/`413`/`415`. No user, no file, no row created. |
| 2. Resolve/create the user | The error propagates; nothing has been stored. |
| 3. Write the file to storage | The error propagates; no row exists. |
| 4. Insert the `materials` row | The file is **deleted** — nothing references those bytes and nothing ever will (§7, §11). |
| 5. Process to `ready`/`failed` | The row and the file are **kept**, `status = 'failed'`, with a safe reason. |

Step 3 before step 4 means a storage failure leaves no row. Step 4's cleanup is
what stops the reverse — a file with no row is an orphan nothing can reach or
reclaim.

**Step 5's failures are deliberately not cleaned up.** A `failed` material keeps
its row and its file, appears in the student's list with a reason it did not work,
and can be deleted by them. Removing it for them would make a failed upload
silently vanish, which is a worse experience and a worse bug report.

`POST /api/materials` returns **201 even when processing ended in `failed`**,
because the material *was* created either way and the response says so in its
`status` and `error` fields. A 4xx would imply nothing had been stored.

The user is **created on demand**, exactly as `POST /api/ask` does — a student who
has never called `POST /api/session` can still upload. The read and delete paths
do **not** create users: reading a URL must not write a row.

---

## 3. Processing lifecycle

```
uploaded ──▶ processing ──▶ ready
                   │
                   └──────▶ failed
```

| State | Meaning | `error_message` | Chunks |
| --- | --- | --- | --- |
| `uploaded` | Bytes are stored, nothing extracted yet | `NULL` | none |
| `processing` | Extraction/chunking in flight | `NULL` | none |
| `ready` | Text extracted, chunked and persisted — usable | `NULL` | ≥ 1 |
| `failed` | Processing gave up | **NOT NULL**, sanitised | none |

Four invariants hold, and each is enforced by something stronger than review:

1. **`ready` implies chunks.** The status change and the chunk INSERT happen in
   **one transaction** (`saveChunksAndMarkReady`), so either both land or neither
   does. There is no code path that marks a material ready without chunks behind
   it.
2. **A failure always carries a reason, and a success never does.** The
   `materials_error_message_matches_status` CHECK constraint makes the opposite
   unstorable — no `failed` row with nothing to show the client, no `ready` row
   with a stale error still attached.
3. **A failed retry leaves nothing behind.** `markFailed` removes any chunks from
   an earlier attempt in the same transaction that sets the status.
4. **`uploaded → processing` is a compare-and-set.** `markProcessing` updates only
   a row still in `uploaded`. If it matches nothing the material was deleted, or
   something else is already processing it, and that throws rather than being
   recorded as a document failure.

**An empty document never becomes `ready`** (§17). Three separate gates:

- a zero-byte upload is a `400` before any row exists;
- a document with no non-whitespace character after normalization is a `failed`
  material — its message names OCR, because a scanned PDF with no text layer is
  the overwhelmingly common cause;
- `material_chunks_content_not_blank` rejects a blank chunk at the database level.

### What a client sees while processing

Because processing is synchronous, `status` is already terminal by the time the
POST returns. `GET /api/materials/:id/status` exists anyway — it is the endpoint a
client polls, and it is the seam that keeps the frontend correct if a later
iteration moves processing into a queue.

---

## 4. Storage architecture

[`src/storage/local-storage.service.js`](../src/storage/local-storage.service.js)
is the **only module on any request path that touches the filesystem**, and
[`tests/materials/architecture.test.js`](../tests/materials/architecture.test.js)
asserts that by grep, against a three-name allowlist: this service, plus
`src/db/migrator.js` and `src/utils/version.js`, which read the migration files and
`package.json` at startup and serve no request. Nothing else in `src/` — no
controller, no service, none of the document modules — imports `fs` at all.
Everything above the storage service deals in opaque **keys** and never in paths,
which is what makes the eventual move to object storage a replacement of one file
rather than a search for `fs.` across the codebase.

Four operations, which is §7's whole interface:

| Function | Behaviour |
| --- | --- |
| `save({buffer, mimeType})` | Generates a key, writes with `flag: "wx"` (fail rather than overwrite) and `mode: 0600`. Returns `{key, size}`. |
| `read(key)` | Bytes, or throws `ENOENT`. |
| `remove(key)` | **Idempotent** — deleting an absent key is a success, so a cleanup path that runs twice is not an error. |
| `exists(key)` | `stat` rather than `access`, so a directory holding a key's name does not read as present. |

`removeQuietly(key, reason)` wraps `remove` for cleanup paths: it logs and
swallows, because the caller is already handling a failure and a secondary storage
error must not replace the primary one.

### Storage keys, and path traversal

Uploaded filenames are attacker-controlled and routinely contain `../`, absolute
paths, NUL bytes, Windows separators, URL escapes, and Unicode that normalises
into a separator. So **keys are not filenames at all**:

```
9f1c3b1e8a244d7f9c2e5a6b7d8e9f01.pdf
└──────── crypto.randomUUID(), hyphens removed ────────┘ └ from the VALIDATED type
```

Three layers, each of which would be sufficient on its own:

1. **`generateKey()` makes the key.** The client's filename contributes nothing to
   it, not even a sanitised form. There is no code path that turns a filename into
   a key, because the safest sanitiser is the one you never have to write.
2. **`KEY_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`) re-validates on every
   entry point** — no separator, no dot-segment, no leading dot. A key that came
   back from the *database* is checked exactly as strictly as one from anywhere
   else: a stored value is not more trustworthy than a fresh one, merely older.
3. **`resolvePath()` proves the resolved absolute path is still inside the root.**
   Redundant given the pattern check, and it stays: a defence that works only while
   a regex is correct is one edit away from not working. `path.sep` is appended to
   the root so a sibling named `uploads-evil` cannot pass a prefix test.

The `materials_storage_key_safe` CHECK constraint mirrors the same rule in SQL.
Both exist because they fail at different times: the constraint stops a bad key
being **stored**, the pattern stops one being **used**.

### Where the bytes live

`STUDYPAL_STORAGE_DIR`, default `<backend>/data/uploads`:

- A relative path resolves against the **backend directory**, not `process.cwd()`
  — starting the server from elsewhere must not split one deployment's uploads
  across two directories. An absolute path is used as given, which is how a
  deployment points this at a mounted volume.
- **Outside every source directory**, and `data/` is in `.gitignore`, so uploaded
  documents cannot be committed (§7, §26).
- Created lazily by the storage service, never as a side effect of reading config.
- Under `NODE_ENV=test` the default moves to a temporary directory, and the test
  harness gives every spawned server its own — a test run cannot write into real
  uploads even if the harness forgets to configure it.

---

## 5. Extraction

[`src/materials/document-extractor.js`](../src/materials/document-extractor.js)
returns `{pages: [{pageNumber, text}], pageCount}` for both formats, so the
pipeline downstream has one shape to handle.

### PDF

`pdf-parse` 2.x, imported lazily so a server that never receives a PDF does not
pay for `pdfjs-dist` at startup. `new PDFParse({data}).getText()` yields
`{total, pages: [{num, text}]}`, so **page numbers come from the parser**, not
from arithmetic — §13 permits `page_number = null` when boundaries are
unreliable, and here they are not. The NULL path still exists for any page the
parser returns with no text, because a wrong citation is worse than an absent one.

The parser is always `destroy()`ed in a `finally`: pdfjs holds a worker and typed
arrays per document, and on a server a leak like that means every upload
permanently costs memory.

Failures are classified by the error's **type**, not by matching its message text,
so a reworded pdfjs error does not silently become the generic case:

| Cause | What the client is told |
| --- | --- |
| `PasswordException` | "This PDF is password-protected. Remove the password and upload it again." |
| `InvalidPDFException` | "This file is not a valid PDF, or it is damaged." |
| Anything else | "This PDF could not be read." |

The parser's own words go to the log via `cause`, never to the response.

### Plain text

`TextDecoder("utf-8", {fatal: false})` — invalid bytes become U+FFFD rather than
throwing, so a file that is mostly readable with one bad byte still yields its
text (§14's "handle invalid input safely"). A student's notes exported from a
Windows editor in Latin-1 are exactly this case, and rejecting the whole document
over one accented character would be the wrong trade.

Replacement characters are then **stripped** — they are decode failures, not
content. Their presence is not an error; their **proportion** is: a file more than
30% replacement characters is not text, it is a binary or an encoding this decoder
cannot read, and storing chunks of noise would be worse than failing.

Plain text produces exactly **one page with `pageNumber: null`** and
`pageCount: null`. Numbering it 1 would assert a page boundary that does not
exist.

---

## 6. Normalization

[`src/materials/text-normalizer.js`](../src/materials/text-normalizer.js). Pure,
deterministic, no configuration and no I/O: the same input always gives the same
output, which is what makes the chunker's tests meaningful. §15 asks for the exact
behaviour to be documented; this is it, **in order**.

| # | Step | Code points |
| --- | --- | --- |
| 1 | Unicode line/paragraph separators → `\n` | U+2028, U+2029 |
| 2 | CRLF and lone CR → `\n` | `\r\n?`, longest match first |
| 3 | Control characters removed, **except `\n` and `\t`** | U+0000–U+0008, U+000B–U+000C, U+000E–U+001F, U+007F–U+009F |
| 4 | Zero-width characters and the BOM removed | U+FEFF, U+200B–U+200D, U+2060 |
| 5 | Non-breaking and exotic spaces → plain space | U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000 |
| 6 | Runs of spaces/tabs collapsed to one space | `[ \t]{2,}` |
| 7 | Trailing spaces/tabs removed from every line | `[ \t]+$` per line |
| 8 | Three or more newlines collapsed to exactly two | `\n{3,}` |
| 9 | Whole-document leading/trailing whitespace removed | `.trim()` |

Order matters in two places. Step 1 runs before step 2 so everything downstream
deals in `\n` only. Step 2's `\r\n?` takes the longest match first — replacing
lone CR first would invent a paragraph break in every Windows document. Step 3
covers §15's "remove null bytes"; U+000B and U+000C are removed because PDF
extractors emit them as layout artefacts. Step 7 runs before step 8 so a "blank"
line carrying two spaces counts as blank.

Every character class is built from **numeric code points**, not written as a
regex literal containing the characters themselves. These are by definition
invisible: pasted literally they make the module unreadable, unreviewable in a
diff, and liable to be mangled by any tool that touches whitespace. The same
convention holds in the fixtures and the tests.

### What normalization deliberately does not do

No summarizing, paraphrasing, rewriting, spell-checking, case folding, stop-word
removal, de-hyphenation across line breaks, and **no LLM**. §15: "The objective is
retrieval-ready source text, not summarization." Two omissions are worth their
reasons:

- **No NFC/NFKC.** NFKC folds the "fi" ligature and rewrites "½" as "1/2", which
  reads like a tidy-up until it reaches mathematics: it also rewrites a
  superscript two as a plain `2`, turning x² into x2. A study document is exactly
  the text where that matters.
- **Single newlines are preserved.** Collapsing them into spaces would read better
  as prose and would destroy every line-structured document — poetry, code
  samples, tables, numbered lists. Step 8 removes blank-line *runs* while leaving
  one blank line, which is the paragraph boundary §15 asks to keep.

`hasMeaningfulText()` is the §17 gate: **any non-whitespace character at all**,
not a word count or a minimum length. "Exam: Friday" is a legitimate document, and
a heuristic that rejected it would be guessing at the user's intent.

---

## 7. Chunking

[`src/materials/text-chunker.js`](../src/materials/text-chunker.js). Character
based, no tokenizer, no model, no vocabulary — so the same text yields the same
chunks on every machine and every version.

| Constant | Value | Why |
| --- | --- | --- |
| `CHUNK_SIZE` | **1800** characters | Middle of §16's 1500–2000 band; ≈300 words, a paragraph or two |
| `CHUNK_OVERLAP` | **250** characters | Mid-range of §16's 200–300; comfortably longer than a sentence |
| `BOUNDARY_SEARCH_FRACTION` | 0.25 → a **450**-character window | Reaches the previous paragraph break in ordinary prose; keeps every chunk ≥75% of target |

These are **named constants in the module**, as §16 asks, not environment
variables — changing them changes what is already stored, so it is a code change
with a migration question attached, not a deployment knob.

**Overlap** exists because a hard split loses whatever straddles the boundary: a
definition beginning 40 characters before the cut leaves one chunk ending
mid-sentence and the next starting mid-sentence, and neither answers a question
about it. Overlapping means every span of ~250 characters appears whole in at
least one chunk. The cost is ~13% duplicated text — cheap storage now, cheap
embedding later.

The *measured* shared text between consecutive chunks is a character or two under
250 (248–249 in practice), because the next chunk's start is also snapped to a
separator boundary rather than landing mid-word. `CHUNK_OVERLAP` is a target, not
an exact byte count, and §16 asks for "approximately 200–300".

**Boundary snap**: each cut is nudged backwards to the nearest natural break
within the 450-character window, preferring paragraph → sentence → line → any
whitespace, and taking the *last* match so the chunk is as full as it can be. The
cut goes *after* the separator, so the boundary characters stay with the chunk
they end. Bounded is the important word: a document with no whitespace at all
(minified JSON, a base64 blob) still chunks at full width rather than degenerating.

**Termination** is asserted, not assumed. The cursor advances by
`chunk length − overlap`, which only grows if the overlap is strictly smaller than
the shortest possible chunk, so the module **throws at import** if the constants
are edited into an unsafe combination — a loud crash on the first test run rather
than a request that hangs in production. The loop additionally takes
`Math.max(cursor + 1, …)` as a seatbelt.

**Pages are chunked independently** (`chunkPages`), producing one continuous
0-based sequence across the document. So no chunk spans two pages and every chunk
can name its source page. The trade-off is real: a paragraph continuing across a
page break is split at the break. That is the right way round for a study tool,
where being able to say "page 12" about a retrieved passage is worth more than the
few sentences that straddle it — and a chunk drawn from two pages could only be
labelled with one of them, or with none.

---

## 8. Database relationships

Added by
[`migrations/postgres/002_materials.sql`](../migrations/postgres/002_materials.sql).
Full column-by-column reasoning lives in that file; the schema tree and the
indexes are in
[`docs/database-architecture.md`](./database-architecture.md) §2–§3.

```
users
  ├── questions          (SP-V2-002)
  └── materials          user_id → users.id, ON DELETE CASCADE
        └── material_chunks   material_id → materials.id, ON DELETE CASCADE
```

`materials`: `id`, `user_id`, `original_filename`, `storage_key`, `mime_type`,
`file_size`, `status`, `page_count`, `error_message`, `created_at`, `updated_at`.

`material_chunks`: `id`, `material_id`, `chunk_index`, `content`, `page_number`,
`char_count`, `created_at`.

Points worth stating rather than reading out of the DDL:

- **`UNIQUE (material_id, chunk_index)`.** Ordering is part of the data, so a
  duplicate index is a corrupt document, not a tolerable retry artefact. It also
  gives the ordered read (`WHERE material_id = $1 ORDER BY chunk_index`) and the
  chunk-count aggregate their index for free, which is why §29's "index chunk
  ordering" needs no separate index.
- **One added index**, `idx_materials_user_created (user_id, created_at DESC)`,
  serving the list endpoint — the only query on these tables that no PK or UNIQUE
  constraint already covers. Same shape and same reasoning as
  `idx_questions_user_created`. This is also §29's "index material ownership".
- **`chunk_index` is 0-based and contiguous**, because it is an offset into a
  sequence rather than a human-facing ordinal.
- **`char_count` is denormalised** and checked against `char_length(content)` by a
  constraint, so a mismatch between the chunker's arithmetic and what was written
  is a write error rather than silent drift.
- **`page_number` is `NULL` for plain text**, and for any PDF page whose text the
  parser could not attribute. Never an invented number.
- **`status` is a CHECK constraint, not a PostgreSQL ENUM**, matching the
  convention 001 set: adding a state to a CHECK is one migration that rewrites no
  rows, whereas `ALTER TYPE … ADD VALUE` cannot run inside a transaction block on
  older servers and cannot remove a value at all.
- **The cascade does not reach the filesystem.** Deleting a *user* through SQL
  removes their materials and chunks but orphans the bytes on disk. Nothing does
  that today — there is no user-deletion endpoint — and the material delete path
  removes the file explicitly. Recorded in §13 rather than papered over with a
  trigger that shells out to the filesystem.

### Queries and transactions

- `saveChunksAndMarkReady` and `markFailed` run in `withTransaction`, so status
  and chunks move together (§11, §29).
- Chunks are inserted with **one** multi-row statement using
  `unnest($2::int[], $3::text[], $4::int[], $5::int[])`, so the statement has a
  fixed parameter count regardless of chunk count.
- The list endpoint uses a `LEFT JOIN LATERAL` to get per-material chunk counts in
  a **single** query — no N+1 (§29) — and selects **no chunk content** (§10: the
  list "must not return document contents").
- Every per-material query filters on `user_id` in SQL. The repository has **no
  by-id-only lookup** to reach for (§6: "Never trust a material ID alone").

---

## 9. API endpoints

All five require a `username`. Errors are always `{"error": "<message>"}`, from the
SP-V2-001 central handler.

| Method | Path | Input | Success |
| --- | --- | --- | --- |
| `POST` | `/api/materials` | multipart: `username`, `file` | `201` — the material |
| `GET` | `/api/materials?username=…` | — | `200` — array, newest first |
| `GET` | `/api/materials/:id?username=…` | — | `200` — the material |
| `GET` | `/api/materials/:id/status?username=…` | — | `200` — status subset |
| `DELETE` | `/api/materials/:id?username=…` | — | `200 {id, deleted: true}` |

### The material shape

```json
{
  "id": 42,
  "filename": "biology-chapter-3.pdf",
  "mimeType": "application/pdf",
  "fileSize": 184320,
  "status": "ready",
  "pageCount": 12,
  "chunkCount": 27,
  "createdAt": "2026-09-06T10:15:00.000Z",
  "updatedAt": "2026-09-06T10:15:02.412Z"
}
```

A `failed` material carries one extra key, `error`, holding the sanitised message
— omitted entirely otherwise, rather than sent as `null`, because a key that is
present but empty reads like a bug in a client checking for its existence.
`pageCount` is the opposite: always present, `null` when the format has no pages
or the parser could not say.

`/status` is a strict subset — `{id, status, pageCount, chunkCount}` plus `error`
— rather than a different shape, so nothing new has to be learned to read it.

**Three things are absent by construction, not by remembering to delete them**
(§18, §21): `storage_key` (the repository's public column list does not select
it), `user_id` (an internal surrogate key the client already knows the username
for), and any filesystem path — no path exists above the storage service at all,
so the service layer has never seen one.

### Errors

| Status | Cause |
| --- | --- |
| `400` | Missing/blank `username`; repeated `username` parameter; username over `MAX_USERNAME_LENGTH`; missing `file` part; more than one `file` part; a file part under the wrong field name; a malformed multipart body; a zero-byte file; a blank or over-long filename; an `:id` that is not a positive integer |
| `404` | The material does not exist, **or is not this user's**, or was already deleted |
| `413` | Upload over `MAX_MATERIAL_BYTES` |
| `415` | Unsupported extension; a `Content-Type` contradicting the extension; content that does not match the extension |

Two choices worth naming:

- **`404`, never `403`, for someone else's material.** A 403 confirms the resource
  is real. One message covers four situations — no such user, no such material,
  not yours, already deleted — so an unauthenticated caller cannot enumerate ids.
- **A second `DELETE` returns `404`.** Not idempotent in the strict sense: the
  service cannot distinguish "you already deleted this" from "this was never
  yours" without keeping tombstones, and answering `200` to the latter would tell
  a caller that someone else's material used to exist.

`DELETE` removes the row (chunks follow by `ON DELETE CASCADE`) and then the file,
in that order. If the unlink fails the result is a few orphaned bytes — logged,
invisible to every client, reclaimable. The other order risks a file gone while
the row still says `ready`, which is a material that lies about being readable.

### Naming

These endpoints use **camelCase**, following §18's example shape. `GET
/api/history` and `GET /api/progress` use snake_case (`has_file`, `created_at`).
That inconsistency is real; it exists because those are a frozen contract §19
forbids changing, and it is recorded here rather than fixed by editing a live
contract. See §13.

---

## 10. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `STUDYPAL_STORAGE_DIR` | `<backend>/data/uploads` | Relative paths resolve against the backend directory. Ignored under `NODE_ENV=test` in favour of an isolated temp directory. |
| `MAX_MATERIAL_BYTES` | `MAX_UPLOAD_BYTES`, i.e. `10485760` | Upload cap for `/api/materials`, separate from `/api/ask`'s attachment cap so raising one does not raise the other. |
| `MATERIAL_LIST_LIMIT` | `100` | Items from `GET /api/materials`. |
| `MAX_MATERIAL_FILENAME_LENGTH` | `512` | Matches the `materials_original_filename_bounded` constraint. |
| `MAX_USERNAME_LENGTH` | `200` | Shared with the existing endpoints. |

Read through `src/config/env.js`, which remains the only reader of `process.env`.
The limit is defined **once** and used by both the multer limit and the validator
(§9: "Do not duplicate hard-coded limits across the application"). Chunk size and
overlap are deliberately **not** environment variables — see §7.

Multer uses `memoryStorage()`: the file arrives as a Buffer and multer never
writes to disk. `DiskStorage` would create a temp file this code would then have
to move, validate and clean up on every error path — and a temp file whose name
multer chooses is a filesystem path the backend does not otherwise have. At a
10 MB cap, holding the buffer is bounded and the whole upload path stays within
one place that writes to disk.

---

## 11. Ownership model

**Materials belong to a `users` row** — `materials.user_id → users.id`, a real
foreign key — and the user is resolved through the **existing**
`src/repositories/user.repository.js`. There is no second users table and no new
identity system (§6).

Every material operation resolves `username → user_id` first and filters on it in
SQL. `material.service.js` has one choke point, `requireOwnedMaterial()`, and the
repository offers no by-id-only alternative, so "never trust a material ID alone"
is a property of the code's shape rather than a rule to remember.

**The limitation, stated plainly.** A username is a *claim*, not a credential.
There is no password, no token and no session. Anyone who knows or guesses a
student's username can upload materials as them, list their documents, read their
metadata and delete them. The ownership checks are real — they stop student A
reaching student B's material *by id* — but they cannot stop someone from simply
asserting they **are** student B. The username also travels in a **query string**
for four of the five endpoints, so it lands in access logs, browser history and
`Referer` headers.

This is S1 in [`docs/security-baseline.md`](./security-baseline.md), it is
pre-existing, and §21 is explicit that SP-V2-003 does not attempt to solve it:
"Keep S1 authentication as known technical debt." **This API is not fit for real
student data until authentication exists.**

---

## 12. Security posture

| Control | Where |
| --- | --- |
| Upload size cap | multer `limits.fileSize` **and** `validateUpload` — the first protects memory by aborting the stream, the second keeps the limit meaningful for callers that did not arrive over HTTP |
| Extension allowlist | multer `fileFilter` (before buffering) and `validateUpload` |
| MIME + content agreement | `file-validation.js` — client claim vs. extension vs. magic bytes |
| Generated storage keys | `generateKey()`; the filename contributes nothing |
| Path traversal | `KEY_PATTERN` + `resolvePath()` root check + the `materials_storage_key_safe` CHECK |
| No user-controlled paths | Callers pass keys; no path exists above the storage service |
| Ownership checks | `requireOwnedMaterial()`, enforced in SQL by `user_id` |
| Cleanup on failure | `removeQuietly` after a failed insert; `markFailed` clears partial chunks |
| Error sanitisation | `ExtractionError` carries `message` (logged) and `safeMessage` (sent); everything else becomes one fixed string |
| No executable handling | The bytes only ever reach a PDF parser or a UTF-8 decoder |
| File permissions | Directory `0700`, files `0600` — the default `0644` would make every student's uploads world-readable on a shared host |

Nothing in a material response contains a filesystem path, a stack frame, SQL
text, parser internals or a storage key.
[`tests/materials/api.test.js`](../tests/materials/api.test.js) asserts that by
serialising every response body and searching it.

---

## 13. Known limitations and technical debt

| # | Limitation | Consequence |
| --- | --- | --- |
| 1 | **No authentication** (S1) | A username is an unverified claim. See §11. The single most important thing to fix before real use. |
| 2 | **Processing is synchronous** | A large PDF holds the HTTP request for a second or two. Deliberate (§30); the seam for a queue is `processMaterial`'s signature. |
| 3 | **No rate limiting** | An unauthenticated caller can upload repeatedly. Same posture as `/api/ask` (S7). |
| 4 | **Deleting a user orphans files** | The FK cascade reaches chunks, not the filesystem. There is no user-deletion endpoint today, so nothing triggers it. |
| 5 | **A failed unlink leaks bytes** | `DELETE` returns success and logs the leak, rather than turning a completed delete into a 500. No client can see the file. |
| 6 | **No deduplication** | The same document uploaded twice is stored twice, with two key sets and two chunk sets. Content addressing is a later decision. |
| 7 | **Storage is node-local** | PostgreSQL no longer restricts instance count, but the storage directory does: two instances without shared storage each see only their own uploads, and an ephemeral filesystem loses every material on redeploy while its `materials` row still says `ready`. Deploying more than one instance needs a shared volume until §15's object-storage move happens. |
| 8 | **No re-processing endpoint** | A `failed` material cannot be retried; the student deletes and re-uploads. `markProcessing`'s compare-and-set is what a retry path would build on. |
| 9 | **Scanned PDFs are refused** | No OCR. The failure message says so explicitly rather than leaving the student to guess. |
| 10 | **camelCase here, snake_case on the older endpoints** | Two conventions in one API. Fixing it means changing a frozen contract (§19). See §9. |
| 11 | **`/api/ask` cannot parse PDFs** | **Pre-existing bug, not introduced here.** `src/services/upload.service.js` calls pdf-parse's 1.x API — `(await import("pdf-parse")).default` — which is `undefined` under 2.4.5, so every PDF sent to `/api/ask` falls back to "[A PDF was uploaded but could not be parsed.]". Fixing it would change that endpoint's answers, which §19 forbids in this ticket, so it needs its own change with its own test. `document-extractor.js` uses the 2.x API correctly. |
| 12 | **`question.service.js` holds inline SQL** | **Pre-existing SP-V2-002 debt.** One `INSERT INTO users … ON CONFLICT` lives in the service so the user upsert and the question insert share a transaction, because `user.repository.upsert` takes no client. The fix is an optional executor argument on that repository function; it belongs to whichever iteration touches `/api/ask` next. Named explicitly in `tests/materials/architecture.test.js`, which also asserts it cannot grow. |

---

## 14. Tests

```bash
npm test                                          # the whole suite
node --test tests/materials/                      # this feature only
```

| File | Covers |
| --- | --- |
| `tests/materials/schema.test.js` | The migration, both tables, FKs, the UNIQUE constraint, the index list, every CHECK, cascade deletion — through SQL, so what is asserted is that the **database** refuses a bad row |
| `tests/materials/processing.test.js` | `validateUpload`, `extractDocument`, `normalizeText`, `hasMeaningfulText`, `chunkText`, `chunkPages` — as pure functions, including determinism, measured overlap, and termination |
| `tests/materials/api.test.js` | All five endpoints over real HTTP against real PostgreSQL: happy paths, every rejection, ownership isolation between two users, empty-document failures, deletion removing chunks **and** the stored file |
| `tests/materials/architecture.test.js` | §27 as tests — SQL confined to the repository, `fs` confined to the storage service and two startup-time readers, no Gemini import under `src/materials`, no deferred infrastructure in `src/` or `package.json`. Every rule is paired with a counter-assertion that its pattern still matches something, because a grep-based check fails by matching nothing and staying green |

PostgreSQL is **real** in every test; Gemini is faked by a `node --import`
preload; storage is a temporary directory per spawned server. Fixtures
([`tests/fixtures/materials.mjs`](../tests/fixtures/materials.mjs),
[`make-pdf.mjs`](../tests/fixtures/make-pdf.mjs)) are small, generated,
deterministic and clearly test data — no real documents, and the PDFs are written
byte by byte rather than committed as binaries.

---

## 15. Where SP-V2-004 attaches

**Embeddings and pgvector are intentionally deferred to SP-V2-004.** The schema is
shaped so that ticket adds to it rather than restructures it.

### RAG and embeddings

`material_chunks` already has the stable identity an embedding needs — `(material_id,
chunk_index)` — plus the `content` an embedding is computed from and the
`page_number` a citation needs. So the next iteration is:

1. `CREATE EXTENSION vector;`
2. `ALTER TABLE material_chunks ADD COLUMN embedding vector(n);` — a nullable add,
   which rewrites no rows
3. An HNSW or IVFFlat index on that column
4. A backfill for existing chunks, and an embed step after
   `saveChunksAndMarkReady`
5. A retrieval service, and a material-scoped chat endpoint

Nothing in this iteration has to move for that. What is deliberately **not** here
is any of it: no vector column, no `tsvector`, no summary column, no embedding
call, no retrieval endpoint, and no `pgvector` dependency —
`tests/materials/architecture.test.js` asserts their absence by grep so an
accidental early start fails a test.

### Object storage

The seam is `local-storage.service.js`'s four functions, not a plugin system.
Moving to S3 or GCS means:

1. Implementing `save`/`read`/`remove`/`exists` against the provider's SDK.
2. Nothing else. Every caller already deals in keys, `storage_key` is already an
   opaque generated identifier that is valid as an object key, and no path exists
   anywhere above that module.

What would then need deciding, and is not decided here: signed URLs for direct
download, whether `storage_key` gains a bucket prefix, and lifecycle rules for
orphans (limitations 4 and 5 above).

### Asynchronous processing

`processMaterial({materialId, storageKey, mimeType})` takes an id and returns the
finished row, so a queue **enqueues a call to it** rather than reimplementing it.
The status lifecycle already models the states a job needs, and `markProcessing`
is already a compare-and-set, so two workers cannot both claim the same material.
The one client-visible change would be that `POST /api/materials` returns
`uploaded` rather than a terminal state — which is exactly why
`GET /api/materials/:id/status` exists now.
