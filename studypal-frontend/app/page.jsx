"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
      " · " +
      d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return "";
  }
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

// ── Practice Question ─────────────────────────────────────────────────────────
function PracticeQuestion({ pq, index }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)" }}
    >
      <p
        style={{
          fontSize: "0.88rem",
          color: "var(--cream)",
          lineHeight: 1.5,
          marginBottom: 8,
        }}
      >
        {index + 1}. {pq.question}
      </p>
      <button
        onClick={() => setOpen(!open)}
        style={{
          fontSize: "0.75rem",
          color: "var(--gold)",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.7")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
      >
        <span
          style={{
            display: "inline-block",
            transition: "transform 0.25s ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▶
        </span>
        {open ? "Hide answer" : "Show answer"}
      </button>
      {open && (
        <div
          className="reveal-answer"
          style={{
            fontSize: "0.83rem",
            color: "var(--green)",
            fontFamily: "'JetBrains Mono',monospace",
            lineHeight: 1.5,
            background: "rgba(76,175,138,0.07)",
            border: "1px solid rgba(76,175,138,0.2)",
            borderRadius: 6,
            padding: "10px 12px",
            marginTop: 10,
          }}
        >
          {pq.answer}
        </div>
      )}
    </div>
  );
}

// ── AI Message ────────────────────────────────────────────────────────────────
function AiMessage({ data }) {
  return (
    <div
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        className="msg-in stagger-1"
        style={{
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          borderRadius: "2px 12px 12px 12px",
          padding: "20px 22px",
        }}
      >
        <div
          style={{
            fontSize: "0.68rem",
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--gold)",
            marginBottom: 10,
          }}
        >
          ✦ StudyPal · {data.topic || "General"}
        </div>
        <p
          style={{ fontSize: "0.9rem", lineHeight: 1.7, color: "var(--cream)" }}
        >
          {data.explanation}
        </p>
      </div>
      {data.practice_questions?.length > 0 && (
        <div
          className="msg-in stagger-2"
          style={{
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "var(--bg3)",
              padding: "10px 18px",
              fontSize: "0.72rem",
              fontWeight: 500,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "var(--muted)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            Practice Questions
          </div>
          {data.practice_questions.map((pq, i) => (
            <PracticeQuestion key={i} pq={pq} index={i} />
          ))}
        </div>
      )}
      {data.encouragement && (
        <div
          className="msg-in stagger-3"
          style={{
            fontSize: "1rem",
            color: "var(--muted)",
            fontStyle: "italic",
            fontFamily: "'Cormorant Garamond',serif",
            padding: "4px 0",
          }}
        >
          ✨ {data.encouragement}
        </div>
      )}
    </div>
  );
}

// ── User Message ──────────────────────────────────────────────────────────────
function UserMessage({ question, filename }) {
  return (
    <div
      className="msg-in-right"
      style={{
        alignSelf: "flex-end",
        maxWidth: "85%",
        background: "linear-gradient(135deg,#22200e,#1e1c0a)",
        border: "1px solid var(--gold-dim)",
        borderRadius: "12px 12px 2px 12px",
        padding: "14px 18px",
      }}
    >
      {filename && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "rgba(201,168,76,0.1)",
            border: "1px solid var(--gold-dim)",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: "0.75rem",
            color: "var(--gold)",
            marginBottom: 8,
          }}
        >
          📎 {filename}
        </div>
      )}
      <p style={{ fontSize: "0.9rem", color: "var(--cream)", lineHeight: 1.5 }}>
        {question}
      </p>
    </div>
  );
}

// ── Typing Indicator ──────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div
      className="msg-in"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--bg2)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "14px 18px",
        alignSelf: "flex-start",
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="typing-dot"
          style={{
            width: 7,
            height: 7,
            background: "var(--gold)",
            borderRadius: "50%",
            display: "inline-block",
          }}
        />
      ))}
    </div>
  );
}

// ── Attach Button ─────────────────────────────────────────────────────────────
function AttachButton({ fileInputRef, onChange }) {
  const [hovered, setHovered] = useState(false);
  return (
    <label
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flexShrink: 0,
        width: 42,
        height: 42,
        background: "var(--bg3)",
        border: `1px solid ${hovered ? "var(--gold-dim)" : "var(--border)"}`,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: hovered ? "var(--gold)" : "var(--muted)",
        fontSize: 17,
        transition: "border-color 0.2s, color 0.2s, transform 0.15s",
        transform: hovered ? "scale(1.06)" : "scale(1)",
      }}
    >
      📎
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.gif"
        style={{ display: "none" }}
        onChange={onChange}
      />
    </label>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────
function HistoryPanel({ history, replayHistory, onSelect }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
      {history.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "40px 16px",
            color: "var(--muted)",
            fontSize: "0.84rem",
          }}
        >
          <div style={{ fontSize: "2rem", marginBottom: 12 }}>🕓</div>Your
          questions will appear here.
        </div>
      ) : (
        history.map((item, i) => (
          <div
            key={i}
            onClick={() => {
              replayHistory(item);
              onSelect && onSelect();
            }}
            className="history-card slide-right"
            style={{
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              cursor: "pointer",
              animationDelay: `${i * 0.04}s`,
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                fontWeight: 500,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--gold)",
                marginBottom: 4,
              }}
            >
              {item.topic}
            </div>
            <div
              style={{
                fontSize: "0.82rem",
                color: "var(--cream)",
                lineHeight: 1.4,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {item.question}
            </div>
            {item.has_file && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: "rgba(201,168,76,0.12)",
                  border: "1px solid var(--gold-dim)",
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontSize: "0.65rem",
                  color: "var(--gold)",
                  marginTop: 6,
                }}
              >
                📎 {item.filename}
              </div>
            )}
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--muted)",
                marginTop: 6,
              }}
            >
              {formatDate(item.created_at)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Progress Panel ────────────────────────────────────────────────────────────
function ProgressPanel({ progress, countKey }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
      <div
        style={{
          background: "var(--bg3)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          marginBottom: 10,
          textAlign: "center",
        }}
      >
        <div
          key={countKey}
          className="pop-in"
          style={{
            fontFamily: "'Cormorant Garamond',serif",
            fontSize: "2.4rem",
            fontWeight: 600,
            color: "var(--gold)",
            lineHeight: 1,
          }}
        >
          {progress.total_questions}
        </div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--muted)",
            marginTop: 4,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Questions Asked
        </div>
      </div>
      <div
        style={{
          fontSize: "0.72rem",
          fontWeight: 500,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: 8,
        }}
      >
        Topics Explored
      </div>
      {progress.topics.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "20px 0",
            color: "var(--muted)",
            fontSize: "0.84rem",
          }}
        >
          <div style={{ fontSize: "1.4rem", marginBottom: 8 }}>🗂️</div>Topics
          appear as you study.
        </div>
      ) : (
        progress.topics.map((t, i) => (
          <div
            key={`${t.topic}-${i}`}
            className="slide-right"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 12px",
              marginBottom: 6,
              fontSize: "0.8rem",
              animationDelay: `${i * 0.05}s`,
              transition: "border-color 0.2s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.borderColor = "var(--gold-dim)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "var(--border)")
            }
          >
            <span style={{ color: "var(--cream)" }}>{t.topic}</span>
            <span
              style={{
                background: "rgba(201,168,76,0.15)",
                color: "var(--gold)",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: "0.72rem",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              {t.count}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [screen, setScreen] = useState("login");
  const [username, setUsername] = useState("");
  const [inputName, setInputName] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState([]);
  const [progress, setProgress] = useState({ total_questions: 0, topics: [] });
  const [countKey, setCountKey] = useState(0);
  const [mobileTab, setMobileTab] = useState("chat"); // 'chat' | 'history' | 'progress'
  const prevTotalRef = useRef(0);
  const chatRef = useRef(null);
  const fileInputRef = useRef(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (chatRef.current)
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (progress.total_questions !== prevTotalRef.current) {
      setCountKey((k) => k + 1);
      prevTotalRef.current = progress.total_questions;
    }
  }, [progress.total_questions]);

  const loadHistory = useCallback(async (user) => {
    const res = await fetch(`${API}/api/history/${encodeURIComponent(user)}`);
    setHistory(await res.json());
  }, []);

  const loadProgress = useCallback(async (user) => {
    const res = await fetch(`${API}/api/progress/${encodeURIComponent(user)}`);
    setProgress(await res.json());
  }, []);

  const handleLogin = async () => {
    if (!inputName.trim()) {
      setLoginError("Please enter your name");
      return;
    }
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: inputName.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setUsername(data.username);
      setScreen("app");
      await Promise.all([
        loadHistory(data.username),
        loadProgress(data.username),
      ]);
    } catch {
      setLoginError("Could not connect to backend. Is it running?");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleAsk = async () => {
    if (!question.trim() || sending) return;
    const q = question.trim();
    const f = file;
    setQuestion("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { type: "user", question: q, filename: f?.name || null },
      { type: "typing" },
    ]);

    const formData = new FormData();
    formData.append("username", username);
    formData.append("question", q);
    if (f) formData.append("file", f);

    try {
      const res = await fetch(`${API}/api/ask`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev.filter((m) => m.type !== "typing"),
        { type: "ai", data },
      ]);
      await Promise.all([loadHistory(username), loadProgress(username)]);
    } catch {
      setMessages((prev) => prev.filter((m) => m.type !== "typing"));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };
  const handleTextarea = (e) => {
    setQuestion(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
  };

  const replayHistory = (item) => {
    setMessages((prev) => [
      ...prev,
      {
        type: "user",
        question: item.question,
        filename: item.has_file ? item.filename : null,
      },
      { type: "ai", data: item.answer },
    ]);
  };

  // ── Login ──────────────────────────────────────────────────────────────────
  if (screen === "login")
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%,#1e1a0e,transparent 70%),var(--bg)",
          position: "relative",
          padding: "20px",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "repeating-linear-gradient(0deg,transparent,transparent 59px,#1e1e2a 59px,#1e1e2a 60px),repeating-linear-gradient(90deg,transparent,transparent 59px,#1e1e2a 59px,#1e1e2a 60px)",
            opacity: 0.4,
            pointerEvents: "none",
          }}
        />
        <div
          className="fade-up"
          style={{
            position: "relative",
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: isMobile ? "40px 28px" : "56px 48px",
            width: "100%",
            maxWidth: 480,
            textAlign: "center",
            boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
          }}
        >
          <div
            className="logo-shimmer"
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 28px",
              fontSize: 28,
            }}
          >
            📚
          </div>
          <h1
            style={{
              fontFamily: "'Cormorant Garamond',serif",
              fontSize: isMobile ? "2rem" : "2.4rem",
              fontWeight: 600,
              color: "var(--cream)",
              marginBottom: 8,
            }}
          >
            StudyPal
          </h1>
          <p
            style={{
              color: "var(--muted)",
              fontSize: "0.92rem",
              marginBottom: 36,
              lineHeight: 1.6,
            }}
          >
            Your personal AI study companion.
            <br />
            Ask anything — get clear explanations and practice questions.
          </p>
          <label
            style={{
              display: "block",
              fontSize: "0.78rem",
              fontWeight: 500,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 8,
              textAlign: "left",
            }}
          >
            Your name or student ID
          </label>
          <input
            type="text"
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="e.g. Amara or STU001"
            autoFocus
            onFocus={(e) => (e.target.style.borderColor = "var(--gold)")}
            onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
            style={{
              width: "100%",
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "14px 16px",
              color: "var(--cream)",
              fontFamily: "inherit",
              fontSize: "0.95rem",
              outline: "none",
              transition: "border-color 0.2s",
            }}
          />
          {loginError && (
            <p
              className="msg-in"
              style={{ color: "var(--red)", fontSize: "0.82rem", marginTop: 8 }}
            >
              {loginError}
            </p>
          )}
          <button
            onClick={handleLogin}
            disabled={loginLoading}
            className={!loginLoading ? "send-pulse" : ""}
            style={{
              width: "100%",
              background: "var(--gold)",
              color: "#0f0f13",
              fontFamily: "inherit",
              fontWeight: 500,
              fontSize: "0.95rem",
              border: "none",
              borderRadius: 10,
              padding: 15,
              cursor: "pointer",
              marginTop: 12,
              opacity: loginLoading ? 0.5 : 1,
            }}
          >
            {loginLoading ? "Starting…" : "Start Studying →"}
          </button>
        </div>
      </div>
    );

  // ── Chat Panel ─────────────────────────────────────────────────────────────
  const ChatPanel = (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg)",
        flex: 1,
      }}
    >
      <div
        ref={chatRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? 16 : 24,
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {messages.length === 0 && (
          <div
            className="welcome-glow fade-up"
            style={{
              background: "linear-gradient(135deg,#1a180e,#0f0f13)",
              border: "1px solid var(--gold-dim)",
              borderRadius: 12,
              padding: isMobile ? "20px 18px" : "28px 32px",
              textAlign: "center",
            }}
          >
            <h2
              style={{
                fontFamily: "'Cormorant Garamond',serif",
                fontSize: isMobile ? "1.4rem" : "1.8rem",
                fontWeight: 600,
                color: "var(--gold)",
                marginBottom: 8,
              }}
            >
              What do you want to learn today?
            </h2>
            <p
              style={{
                color: "var(--muted)",
                fontSize: "0.9rem",
                lineHeight: 1.6,
              }}
            >
              Type a topic, paste a question, or upload a file.
              <br />
              I'll explain it simply and give you practice questions.
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          if (msg.type === "user")
            return (
              <UserMessage
                key={i}
                question={msg.question}
                filename={msg.filename}
              />
            );
          if (msg.type === "typing") return <TypingIndicator key={i} />;
          if (msg.type === "ai") return <AiMessage key={i} data={msg.data} />;
        })}
      </div>

      <div
        className="rise-up"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--bg2)",
          padding: isMobile ? "12px 14px" : "16px 20px",
        }}
      >
        {file && (
          <div
            className="file-in"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(201,168,76,0.08)",
              border: "1px solid var(--gold-dim)",
              borderRadius: 8,
              padding: "8px 14px",
              marginBottom: 12,
              fontSize: "0.82rem",
              color: "var(--gold)",
            }}
          >
            📎 {file.name}
            <button
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              style={{
                marginLeft: "auto",
                background: "none",
                border: "none",
                color: "var(--muted)",
                cursor: "pointer",
                fontSize: "1rem",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = "var(--muted)")
              }
            >
              ✕
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <AttachButton
            fileInputRef={fileInputRef}
            onChange={(e) => setFile(e.target.files[0] || null)}
          />
          <textarea
            value={question}
            onChange={handleTextarea}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or topic…"
            rows={1}
            onFocus={(e) => (e.target.style.borderColor = "var(--gold)")}
            onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
            style={{
              flex: 1,
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "11px 14px",
              color: "var(--cream)",
              fontFamily: "inherit",
              fontSize: "0.9rem",
              resize: "none",
              outline: "none",
              lineHeight: 1.5,
              minHeight: 44,
              maxHeight: 140,
              transition: "border-color 0.2s",
            }}
          />
          <button
            onClick={handleAsk}
            disabled={sending}
            className={!sending ? "send-pulse" : ""}
            style={{
              flexShrink: 0,
              width: 42,
              height: 42,
              background: "var(--gold)",
              border: "none",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: sending ? "not-allowed" : "pointer",
              fontSize: 17,
              color: "#0f0f13",
              opacity: sending ? 0.4 : 1,
            }}
          >
            ➤
          </button>
        </div>
        {!isMobile && (
          <p
            style={{
              fontSize: "0.72rem",
              color: "var(--muted)",
              marginTop: 8,
              textAlign: "center",
            }}
          >
            Supports PDF, images & text · Enter to send · Powered by Gemini
          </p>
        )}
      </div>
    </main>
  );

  // ── Mobile Bottom Nav ──────────────────────────────────────────────────────
  const MobileNav = (
    <nav
      style={{
        display: "flex",
        borderTop: "1px solid var(--border)",
        background: "var(--bg2)",
        height: 56,
      }}
    >
      {[
        { id: "chat", icon: "", label: "Chat" },
        { id: "history", icon: "", label: "History" },
        { id: "progress", icon: "", label: "Progress" },
      ].map((tab) => (
        <button
          key={tab.id}
          onClick={() => setMobileTab(tab.id)}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: mobileTab === tab.id ? "var(--gold)" : "var(--muted)",
            fontSize: "0.65rem",
            fontFamily: "inherit",
            fontWeight: 500,
            letterSpacing: "0.04em",
            transition: "color 0.15s",
            borderTop:
              mobileTab === tab.id
                ? "2px solid var(--gold)"
                : "2px solid transparent",
          }}
        >
          <span style={{ fontSize: 18 }}>{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </nav>
  );

  // ── App: Mobile ────────────────────────────────────────────────────────────
  if (isMobile)
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
        }}
      >
        <header
          className="header-drop"
          style={{
            background: "var(--bg2)",
            borderBottom: "1px solid var(--border)",
            padding: "0 16px",
            height: 54,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              className="logo-shimmer"
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
              }}
            >
              📚
            </div>
            <span
              style={{
                fontFamily: "'Cormorant Garamond',serif",
                fontSize: "1.2rem",
                fontWeight: 600,
                color: "var(--cream)",
              }}
            >
              StudyPal
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--bg3)",
              border: "1px solid var(--border)",
              borderRadius: 100,
              padding: "5px 12px",
              fontSize: "0.8rem",
              color: "var(--muted)",
            }}
          >
            👤&nbsp;
            <strong style={{ color: "var(--cream)" }}>{username}</strong>
          </div>
        </header>

        {/* Mobile tab content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {mobileTab === "chat" && ChatPanel}
          {mobileTab === "history" && (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                background: "var(--bg2)",
              }}
            >
              <div
                style={{
                  padding: "14px 16px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                }}
              >
                📋 Question History
              </div>
              <HistoryPanel
                history={history}
                replayHistory={replayHistory}
                onSelect={() => setMobileTab("chat")}
              />
            </div>
          )}
          {mobileTab === "progress" && (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                background: "var(--bg2)",
              }}
            >
              <div
                style={{
                  padding: "14px 16px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                }}
              >
                📊 My Progress
              </div>
              <ProgressPanel progress={progress} countKey={countKey} />
            </div>
          )}
        </div>

        {MobileNav}
      </div>
    );

  // ── App: Desktop ───────────────────────────────────────────────────────────
  return (
    <div>
      <header
        className="header-drop"
        style={{
          background: "var(--bg2)",
          borderBottom: "1px solid var(--border)",
          padding: "0 24px",
          height: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            className="logo-shimmer"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
            }}
          >
            📚
          </div>
          <span
            style={{
              fontFamily: "'Cormorant Garamond',serif",
              fontSize: "1.3rem",
              fontWeight: 600,
              color: "var(--cream)",
            }}
          >
            StudyPal
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--bg3)",
            border: "1px solid var(--border)",
            borderRadius: 100,
            padding: "6px 14px",
            fontSize: "0.85rem",
            color: "var(--muted)",
          }}
        >
          👤&nbsp;<strong style={{ color: "var(--cream)" }}>{username}</strong>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "280px 1fr 260px",
          height: "calc(100vh - 60px)",
          overflow: "hidden",
        }}
      >
        {/* LEFT: History */}
        <aside
          className="sidebar-left"
          style={{
            background: "var(--bg2)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.72rem",
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            📋 Question History
          </div>
          <HistoryPanel history={history} replayHistory={replayHistory} />
        </aside>

        {ChatPanel}

        {/* RIGHT: Progress */}
        <aside
          className="sidebar-right"
          style={{
            background: "var(--bg2)",
            borderLeft: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.72rem",
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            📊 My Progress
          </div>
          <ProgressPanel progress={progress} countKey={countKey} />
        </aside>
      </div>
    </div>
  );
}
