"use client";
export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase())) headers.set("X-StudyPal-Request", "1");
  const response = await fetch(url, { ...options, headers, credentials: "include" });
  if (response.status === 401 && !String(url).includes("/api/auth/")) window.dispatchEvent(new Event("studypal-session-expired"));
  return response;
}
