/**
 * Baseline response security headers.
 *
 * Written by hand rather than adding `helmet`, because SP-V2-001 is instructed
 * not to introduce dependencies it does not need. This is a JSON API with no
 * HTML responses and no cookies, so only a handful of helmet's headers are
 * meaningful here — those are set below.
 *
 * `helmet` is still the right answer once the service starts serving anything
 * browser-rendered; that recommendation is recorded in
 * docs/security-baseline.md rather than acted on here.
 */

import { config } from "../config/env.js";

export function securityHeaders(_req, res, next) {
  // Do not let a browser second-guess our declared content types.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // This API is never a frame's document.
  res.setHeader("X-Frame-Options", "DENY");
  // Do not leak API paths to third parties via the Referer header.
  res.setHeader("Referrer-Policy", "no-referrer");
  // Responses are per-student; keep them out of shared caches.
  res.setHeader("Cache-Control", "no-store");

  // Only meaningful over TLS, and setting it in development would pin
  // localhost to HTTPS in the developer's browser.
  if (config.isProduction) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  next();
}
