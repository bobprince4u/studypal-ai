"use client";
import { apiFetch } from "../auth-client";
import { useAuth } from "../auth-provider";

/**
 * SP-V2-006 — the minimum exam flow (§17).
 *
 * WHAT THIS IS
 * ------------
 * One screen per step of the flow the ticket describes: sign in, describe an
 * exam, generate it, sit it, submit it, read the result, and see past attempts.
 * Nothing else. §17 is explicit that this is "the minimum exam flow", not a
 * redesign of StudyPal — the chat page is untouched and this is a separate
 * route, reachable from a single link in its header.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP (§4, §17)
 * -----------------------------------------------
 * "The frontend must never contain the authoritative answer key."
 *
 * That is enforced by the shape of the code rather than by care:
 *
 *   - The type below has no `correctAnswer`, `explanation` or `isCorrect` on a
 *     question being sat, because the API does not send them before submission
 *     and this file never invents them.
 *   - `correctAnswer`, `explanation` and `isCorrect` are read in exactly one
 *     place — the results screen, from a SUBMITTED attempt's response.
 *   - No score, percentage or pass/fail is computed here. §5: "The server is
 *     authoritative." `result.percentage` and `result.passed` are printed as
 *     received, and the only arithmetic in this file is formatting.
 *
 * A client-side grader would be a real bug rather than a shortcut: §5 forbids
 * the server from trusting a submitted score, so the two would disagree and the
 * server would win, leaving a screen that says "80%" above a result of 60%.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No timer, no question shuffling, no resume-an-abandoned-attempt, no charts
 * (§18 defers analytics to SP-V2-007), and no option to reveal an answer while
 * the exam is in progress — the API cannot serve one, so offering the button
 * would be a lie.
 */

import { useCallback, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const DIFFICULTIES = ["easy", "medium", "hard"];
const DEFAULT_QUESTION_COUNT = 10;

/** A step in the flow. One visible screen at a time; this is not a router. */
const STEP = {
  signIn: "signIn",
  compose: "compose",
  sitting: "sitting",
  result: "result",
};

/**
 * A question as it arrives BEFORE submission — the shape the API sends while
 * taking an exam, which has no answer on it.
 *
 * This comment is the contract: if a `correctAnswer` ever appears in an object
 * typed as TakingQuestion, the API has started leaking the key and the leak is
 * visible here rather than only in the network tab.
 *
 * @typedef {{
 *   id: number, order: number, type: "multiple_choice" | "true_false",
 *   question: string, options: Array<{id: string, text: string}>,
 *   sourceMaterialId: number | null
 * }} TakingQuestion
 */

export default function ExamPage() {
  const [step, setStep] = useState(STEP.signIn);
  const [username, setUsername] = useState("");
  const account = useAuth();
  const inputName = account.username;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Compose
  const [subject, setSubject] = useState("");
  const [topics, setTopics] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [questionCount, setQuestionCount] = useState(DEFAULT_QUESTION_COUNT);
  const [materials, setMaterials] = useState([]);
  const [selectedMaterials, setSelectedMaterials] = useState([]);

  // Sitting
  const [exam, setExam] = useState(null);
  const [attempt, setAttempt] = useState(null);
  /** @type {[Record<number, string>, Function]} questionId -> chosen option id */
  const [answers, setAnswers] = useState({});

  // Result
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const fail = (message) => {
    setError(message);
    setBusy(false);
  };

  /** Read a response as JSON, turning any non-2xx into the same throw. */
  const send = useCallback(async (path, options) => {
    const res = await apiFetch(`${API}${path}`, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      // A body that is not JSON is still a failed request, and saying so beats
      // an "undefined" surfacing three frames up.
      throw new Error("The server sent a response this page could not read.");
    }
    if (!res.ok) throw new Error(body?.error || "Something went wrong.");
    return body;
  }, []);

  const signIn = async () => {
    const name = inputName.trim();
    if (!name) return setError("Please enter your name.");
    setBusy(true);
    setError("");
    try {
      const session = await send("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setUsername(session.username);
      // Materials are optional — an exam on topics alone is first-class (§6) —
      // so a failure here must not block the screen.
      try {
        setMaterials(
          await send("/api/materials"),
        );
      } catch {
        setMaterials([]);
      }
      setStep(STEP.compose);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!subject.trim()) return setError("Please enter a subject.");
    setBusy(true);
    setError("");
    try {
      const created = await send("/api/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          topics: topics
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          difficulty,
          questionCount: Number(questionCount),
          materialIds: selectedMaterials,
        }),
      });
      setExam(created);
      setStep(STEP.sitting);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Start a fresh attempt at the exam already generated.
   *
   * A new attempt every time: §11 makes a submitted attempt immutable and this
   * page never tries to reuse one, so "retake" is honest about what it does.
   */
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const started = await send(`/api/exams/${exam.id}/attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setAttempt(started);
      setAnswers({});
      setResult(null);
      setStep(STEP.sitting);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      // Only questionId and the chosen option id. §5: the client submits an
      // answer, never a judgement about it.
      const payload = Object.entries(answers).map(([questionId, answer]) => ({
        questionId: Number(questionId),
        answer,
      }));
      const graded = await send(
        `/api/exams/${exam.id}/attempts/${attempt.id}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: payload }),
        },
      );
      setResult(graded);
      setStep(STEP.result);
      try {
        setHistory(await send("/api/exam-attempts"));
      } catch {
        setHistory([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ── shared pieces ──────────────────────────────────────────────────────────

  const page = {
    minHeight: "100vh",
    background:
      "radial-gradient(ellipse 80% 60% at 50% 0%,#1e1a0e,transparent 70%),var(--bg)",
    padding: "40px 20px 80px",
  };
  const shell = { maxWidth: 760, margin: "0 auto" };
  const card = {
    background: "var(--bg2)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 22,
    marginBottom: 16,
  };
  const input = {
    width: "100%",
    background: "var(--bg3)",
    border: "1px solid var(--border)",
    borderRadius: 9,
    padding: "11px 13px",
    color: "var(--cream)",
    fontFamily: "inherit",
    fontSize: "0.92rem",
    outline: "none",
  };
  const label = {
    display: "block",
    fontSize: "0.74rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--muted)",
    marginBottom: 7,
  };
  const primary = {
    background: "var(--gold)",
    color: "#151515",
    border: "none",
    borderRadius: 9,
    padding: "11px 22px",
    fontWeight: 500,
    fontFamily: "inherit",
    fontSize: "0.9rem",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.6 : 1,
  };
  const quiet = { ...primary, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" };

  const ErrorNote = () =>
    error ? (
      <p
        style={{
          background: "rgba(224,112,112,0.1)",
          border: "1px solid rgba(224,112,112,0.35)",
          color: "var(--red)",
          borderRadius: 9,
          padding: "10px 13px",
          fontSize: "0.86rem",
          marginBottom: 16,
        }}
      >
        {error}
      </p>
    ) : null;

  const Heading = ({ children }) => (
    <h1
      style={{
        fontFamily: "'Cormorant Garamond',serif",
        fontSize: "1.9rem",
        fontWeight: 600,
        marginBottom: 6,
      }}
    >
      {children}
    </h1>
  );

  // ── 1. sign in ─────────────────────────────────────────────────────────────

  if (step === STEP.signIn)
    return (
      <div style={page}>
        <div style={{ ...shell, maxWidth: 420 }}>
          <div className="fade-up" style={{ ...card, padding: 32, marginTop: 60 }}>
            <Heading>Exams</Heading>
            <p style={{ color: "var(--muted)", fontSize: "0.88rem", marginBottom: 24 }}>
              Generate a practice exam and sit it. Your answers are marked on the
              server.
            </p>
            <ErrorNote />
            <p>Signed in as {inputName}</p>
            <button style={primary} onClick={signIn} disabled={busy}>
              {busy ? "Signing in…" : "Continue"}
            </button>
            <p style={{ marginTop: 20, fontSize: "0.8rem" }}>
              <a href="/" style={{ color: "var(--gold)", textDecoration: "none" }}>
                ← Back to StudyPal
              </a>
            </p>
          </div>
        </div>
      </div>
    );

  // ── 2. compose ─────────────────────────────────────────────────────────────

  if (step === STEP.compose)
    return (
      <div style={page}>
        <div style={shell}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Heading>New exam</Heading>
            <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{username}</span>
          </div>

          <div style={card}>
            <ErrorNote />
            <label style={label} htmlFor="exam-subject">
              Subject
            </label>
            <input
              id="exam-subject"
              style={{ ...input, marginBottom: 18 }}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Photosynthesis"
            />

            <label style={label} htmlFor="exam-topics">
              Topics — optional, comma separated
            </label>
            <input
              id="exam-topics"
              style={{ ...input, marginBottom: 18 }}
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="light reactions, Calvin cycle"
            />

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
              <div style={{ flex: "1 1 180px" }}>
                <label style={label} htmlFor="exam-difficulty">
                  Difficulty
                </label>
                <select
                  id="exam-difficulty"
                  style={input}
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d} style={{ background: "var(--bg3)" }}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <label style={label} htmlFor="exam-count">
                  Questions
                </label>
                <input
                  id="exam-count"
                  type="number"
                  min="1"
                  max="50"
                  style={input}
                  value={questionCount}
                  onChange={(e) => setQuestionCount(e.target.value)}
                />
              </div>
            </div>

            {materials.length > 0 && (
              <>
                <label style={label}>
                  Ground it in your documents — optional
                </label>
                <div style={{ marginBottom: 18 }}>
                  {materials.map((material) => {
                    const on = selectedMaterials.includes(material.id);
                    return (
                      <button
                        key={material.id}
                        onClick={() =>
                          setSelectedMaterials((current) =>
                            on
                              ? current.filter((id) => id !== material.id)
                              : [...current, material.id],
                          )
                        }
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          background: on ? "rgba(201,168,76,0.1)" : "var(--bg3)",
                          border: `1px solid ${on ? "var(--gold-dim)" : "var(--border)"}`,
                          borderRadius: 9,
                          padding: "10px 13px",
                          marginBottom: 8,
                          color: on ? "var(--cream)" : "var(--muted)",
                          fontFamily: "inherit",
                          fontSize: "0.86rem",
                          cursor: "pointer",
                        }}
                      >
                        {on ? "✓ " : ""}
                        {material.filename}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <button style={primary} onClick={generate} disabled={busy}>
              {busy ? "Generating…" : "Generate exam"}
            </button>
            <p style={{ color: "var(--muted)", fontSize: "0.76rem", marginTop: 12 }}>
              Generation takes a few seconds. Nothing is charged for a retry.
            </p>
          </div>

          <p style={{ fontSize: "0.8rem" }}>
            <a href="/" style={{ color: "var(--gold)", textDecoration: "none" }}>
              ← Back to StudyPal
            </a>
          </p>
        </div>
      </div>
    );

  // ── 3. sitting ─────────────────────────────────────────────────────────────

  if (step === STEP.sitting) {
    // The questions arrive with the attempt when one is started, and on the exam
    // itself before that — either way this is the un-answered paper.
    const questions = attempt ? attempt.exam.questions : exam.questions;
    const answered = Object.keys(answers).length;

    return (
      <div style={page}>
        <div style={shell}>
          <Heading>{exam.title}</Heading>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginBottom: 20 }}>
            {exam.subject} · {exam.difficulty} · {questions.length} questions
            {exam.materialIds.length > 0 ? " · grounded in your documents" : ""}
          </p>

          <ErrorNote />

          {!attempt ? (
            <div style={card}>
              <p style={{ fontSize: "0.9rem", marginBottom: 16 }}>
                Start the attempt when you are ready. Your answers are marked
                after you submit.
              </p>
              <button style={primary} onClick={start} disabled={busy}>
                {busy ? "Starting…" : "Start exam"}
              </button>
            </div>
          ) : (
            <>
              {questions.map((question) => (
                <div key={question.id} style={card}>
                  <p
                    style={{
                      fontSize: "0.95rem",
                      lineHeight: 1.5,
                      marginBottom: 14,
                    }}
                  >
                    <span style={{ color: "var(--gold)", marginRight: 8 }}>
                      {question.order}.
                    </span>
                    {question.question}
                  </p>
                  {question.options.map((option) => {
                    const on = answers[question.id] === option.id;
                    return (
                      <button
                        key={option.id}
                        onClick={() =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id]: option.id,
                          }))
                        }
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          background: on ? "rgba(201,168,76,0.1)" : "transparent",
                          border: `1px solid ${on ? "var(--gold-dim)" : "var(--border)"}`,
                          borderRadius: 9,
                          padding: "10px 13px",
                          marginBottom: 8,
                          color: on ? "var(--cream)" : "var(--muted)",
                          fontFamily: "inherit",
                          fontSize: "0.87rem",
                          lineHeight: 1.45,
                          cursor: "pointer",
                        }}
                      >
                        <strong style={{ marginRight: 8, color: on ? "var(--gold)" : "inherit" }}>
                          {option.id}
                        </strong>
                        {option.text}
                      </button>
                    );
                  })}
                </div>
              ))}

              <div style={{ ...card, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <button style={primary} onClick={submit} disabled={busy}>
                  {busy ? "Submitting…" : "Submit exam"}
                </button>
                <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                  {answered} of {questions.length} answered
                  {answered < questions.length ? " — unanswered questions count as wrong" : ""}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── 4. result ──────────────────────────────────────────────────────────────

  // Every number below is the server's, printed as received (§5). The only
  // question fields read here that were absent while sitting are the answer key
  // and the explanation, which §9 permits only after submission.
  return (
    <div style={page}>
      <div style={shell}>
        <Heading>{result.passed ? "Passed" : "Not passed"}</Heading>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginBottom: 20 }}>
          {exam.title} · {new Date(result.submittedAt).toLocaleString()}
        </p>

        <div
          style={{
            ...card,
            display: "flex",
            gap: 28,
            flexWrap: "wrap",
            borderColor: result.passed ? "var(--gold-dim)" : "var(--border)",
          }}
        >
          {[
            ["Score", `${result.percentage}%`],
            ["Correct", `${result.correctAnswers} / ${result.totalQuestions}`],
            ["Result", result.passed ? "Pass" : "Fail"],
          ].map(([name, value]) => (
            <div key={name}>
              <div style={{ ...label, marginBottom: 4 }}>{name}</div>
              <div
                style={{
                  fontFamily: "'Cormorant Garamond',serif",
                  fontSize: "1.8rem",
                  color: name === "Result" ? (result.passed ? "var(--green)" : "var(--red)") : "var(--cream)",
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>

        {result.questions.map((question) => (
          <div
            key={question.id}
            style={{
              ...card,
              borderLeft: `3px solid ${question.isCorrect ? "var(--green)" : "var(--red)"}`,
            }}
          >
            <p style={{ fontSize: "0.95rem", lineHeight: 1.5, marginBottom: 12 }}>
              <span style={{ color: "var(--gold)", marginRight: 8 }}>{question.order}.</span>
              {question.question}
            </p>
            {question.options.map((option) => {
              const isKey = option.id === question.correctAnswer;
              const chosen = option.id === question.selectedAnswer;
              return (
                <div
                  key={option.id}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    marginBottom: 6,
                    fontSize: "0.87rem",
                    lineHeight: 1.45,
                    background: isKey
                      ? "rgba(76,175,138,0.1)"
                      : chosen
                        ? "rgba(224,112,112,0.1)"
                        : "transparent",
                    border: `1px solid ${
                      isKey ? "rgba(76,175,138,0.4)" : chosen ? "rgba(224,112,112,0.4)" : "var(--border)"
                    }`,
                    color: isKey || chosen ? "var(--cream)" : "var(--muted)",
                  }}
                >
                  <strong style={{ marginRight: 8 }}>{option.id}</strong>
                  {option.text}
                  {isKey && <span style={{ color: "var(--green)", marginLeft: 8 }}>← correct</span>}
                  {chosen && !isKey && (
                    <span style={{ color: "var(--red)", marginLeft: 8 }}>← your answer</span>
                  )}
                </div>
              );
            })}
            {!question.selectedAnswer && (
              <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 6 }}>
                You left this unanswered.
              </p>
            )}
            {question.explanation && (
              <p
                className="reveal-answer"
                style={{
                  color: "var(--muted)",
                  fontSize: "0.84rem",
                  lineHeight: 1.55,
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid var(--border)",
                }}
              >
                {question.explanation}
              </p>
            )}
          </div>
        ))}

        <div style={{ ...card, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button style={primary} onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Retake this exam"}
          </button>
          <button
            style={quiet}
            onClick={() => {
              setExam(null);
              setAttempt(null);
              setResult(null);
              setAnswers({});
              setError("");
              setStep(STEP.compose);
            }}
          >
            New exam
          </button>
        </div>

        {history.length > 0 && (
          <div style={card}>
            <div style={{ ...label, marginBottom: 12 }}>Recent attempts</div>
            {history.map((row) => (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border)",
                  fontSize: "0.85rem",
                }}
              >
                <span style={{ color: "var(--muted)" }}>
                  {row.examTitle} · {new Date(row.startedAt).toLocaleDateString()}
                </span>
                <span
                  style={{
                    color:
                      row.status !== "completed"
                        ? "var(--muted)"
                        : row.passed
                          ? "var(--green)"
                          : "var(--red)",
                  }}
                >
                  {row.status === "completed" ? `${row.percentage}%` : "in progress"}
                </span>
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: "0.8rem" }}>
          <a href="/" style={{ color: "var(--gold)", textDecoration: "none" }}>
            ← Back to StudyPal
          </a>
        </p>
      </div>
    </div>
  );
}
