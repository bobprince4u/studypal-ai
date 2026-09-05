/**
 * The service version, read from package.json at startup.
 *
 * Read once and cached: GET /health reports it, and touching the filesystem on
 * every probe would be wasteful. Falls back to "unknown" rather than throwing,
 * since a missing version must never be the reason a health check fails.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "../config/env.js";

function readVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(config.backendRoot, "package.json"), "utf-8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const version = readVersion();
