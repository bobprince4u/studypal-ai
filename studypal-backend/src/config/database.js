/**
 * SQLite connection and schema bootstrap.
 *
 * Extracted verbatim from server.js:18-37. The schema DDL is unchanged — same
 * tables, same columns, same defaults — so an existing studypal.db keeps
 * working untouched. `migrations/001_initial_schema.sql` records the same DDL
 * as the starting point for real migration tooling in SP-V2-002.
 *
 * better-sqlite3 is synchronous and in-process, so there is no pool and no
 * connect step: opening the file IS the connection.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { config } from "./env.js";
import { logger } from "../utils/logger.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    topic TEXT DEFAULT 'Study Topic',
    has_file INTEGER DEFAULT 0,
    filename TEXT,
    created_at TEXT NOT NULL
  );
`;

let db = null;

/**
 * Open the database (idempotent) and ensure the schema exists.
 * @returns {import("better-sqlite3").Database}
 */
export function getDatabase() {
  if (db) return db;

  const file = config.database.path;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  logger.info(`database ready at ${file}`);
  return db;
}

/** Close the connection. Used by tests and graceful shutdown. */
export function closeDatabase() {
  if (!db) return;
  db.close();
  db = null;
}

/**
 * Cheap liveness probe for GET /health. Deliberately does not touch Gemini.
 * @returns {{ok: boolean, error?: string}}
 */
export function checkDatabaseHealth() {
  try {
    getDatabase().prepare("SELECT 1").get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
