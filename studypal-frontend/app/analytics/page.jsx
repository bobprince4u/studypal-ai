"use client";

import { useState } from "react";
const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const display = value => value === null ? "No data" : String(value);

export default function AnalyticsPage() {
  const [username, setUsername] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [planId, setPlanId] = useState("");
  const [plan, setPlan] = useState(null);
  async function read(path, name) {
    const response = await fetch(`${API}/api/analytics${path}?username=${encodeURIComponent(name)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Analytics could not be loaded.");
    return body;
  }
  async function load(event) {
    event.preventDefault();
    setBusy(true); setError(""); setData(null); setPlan(null);
    try {
      const name = username.trim();
      const [summary, history, topics, weak, materials] = await Promise.all(
        ["", "/exams", "/topics", "/weak-areas", "/materials"].map(path => read(path, name)),
      );
      setData({ name, summary, history, topics, weak, materials });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function loadPlan(event) {
    event.preventDefault(); setError(""); setPlan(null); setBusy(true);
    try { setPlan(await read(`/study-plans/${encodeURIComponent(planId)}`, data.name)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 1000, margin: "40px auto", padding: 24 }}>
    <nav><a href="/">StudyPal</a> · <a href="/exam">Exams</a></nav>
    <h1>Learning analytics</h1>
    <p>Progress and performance from your recorded study activity.</p>
    <form onSubmit={load}>
      <label>Username <input value={username} onChange={e => setUsername(e.target.value)} required maxLength={100} /></label>{" "}
      <button disabled={busy}>{busy ? "Loading…" : "View analytics"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <h2>Overview for {data.name}</h2>
      {Object.entries(data.summary).filter(([key]) => key !== "trend").map(([group, metrics]) => <section key={group}>
        <h3>{group === "studyPlans" ? "Study plans" : group === "tasks" ? "Study tasks" : "Exam performance"}</h3>
        <dl>{Object.entries(metrics).map(([key, value]) => <div key={key} style={{ display: "flex", gap: 12, marginBottom: 6 }}>
          <dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{display(value)}</dd>
        </div>)}</dl>
      </section>)}
      <h2>Recent performance comparison</h2>
      {data.summary.trend.direction === null ? <p>More completed attempts are needed for a comparison.</p> : <p>
        Recent average: {data.summary.trend.recentAveragePercentage}%. Previous average: {data.summary.trend.previousAveragePercentage}%.
        Difference: {data.summary.trend.difference} percentage points ({data.summary.trend.direction}).
      </p>}
      <h2>Study plan progress</h2>
      <form onSubmit={loadPlan}><label>Plan ID <input type="number" min="1" required value={planId} onChange={e => setPlanId(e.target.value)} /></label>{" "}<button disabled={busy}>View plan</button></form>
      {plan && <p>{plan.title}: {plan.tasks.completed} of {plan.tasks.total} tasks completed ({display(plan.tasks.completionPercentage)}{plan.tasks.completionPercentage === null ? "" : "%"}). Status: {plan.status}.</p>}
      <h2>Topic performance</h2>
      <p>Topics describe the exam as a whole. Questions in an exam with multiple topics count toward each topic; these results do not identify individual question topics.</p>
      <Breakdown rows={data.topics} label="Topic" name={row => row.topic} />
      <h2>Observed weak areas</h2>
      <p>At least three answered questions and accuracy strictly below 60% qualify under the default settings. This describes past results.</p>
      <Breakdown rows={data.weak} label="Topic" name={row => row.topic} />
      <h2>Material performance</h2>
      <Breakdown rows={data.materials} label="Material" name={row => row.filename ?? "Unavailable attribution"} />
      <h2>Recent completed attempts</h2>
      {data.history.length === 0 ? <p>No completed attempts yet.</p> : <table><thead><tr><th>Exam</th><th>Percentage</th><th>Result</th><th>Submitted (UTC)</th></tr></thead>
        <tbody>{data.history.map(row => <tr key={row.attemptId}><td>{row.examTitle}</td><td>{row.percentage}%</td><td>{row.passed ? "Passed" : "Failed"}</td><td>{row.submittedAt}</td></tr>)}</tbody></table>}
    </>}
  </main>;
}
function Breakdown({ rows, label, name }) {
  return rows.length === 0 ? <p>No results to show.</p> : <table style={{ width: "100%", textAlign: "left", marginBottom: 24 }}>
    <thead><tr><th>{label}</th><th>Answered</th><th>Correct</th><th>Incorrect</th><th>Accuracy</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}><td>{name(row)}</td><td>{row.questionsAttempted}</td><td>{row.correct}</td><td>{row.incorrect}</td><td>{display(row.accuracyPercentage)}%</td></tr>)}</tbody>
  </table>;
}
