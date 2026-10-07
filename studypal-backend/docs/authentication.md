# StudyPal authentication operations

The complete design, API migration, ownership invariant, browser controls, rate limits and known limitations are documented in [authentication-architecture.md](authentication-architecture.md). Verification is recorded in [sp-v2-008-final-report.md](sp-v2-008-final-report.md).

Before deploying: back up PostgreSQL; apply migration 006 through `npm run migrate`; configure production HTTPS origins and a same-site frontend/API; build with the correct `NEXT_PUBLIC_API_URL`; verify trusted owners before provisioning locked legacy accounts. Do not restore anonymous username access.

For legacy credential provisioning or reset, run `node scripts/provision-auth.mjs` with private stdin JSON containing `username` and `password`. Credentials must not appear in command-line arguments, shell history or logs. Existing IDs and learning resources remain unchanged; all account sessions are revoked. No developer database has been provisioned as part of this task.

Browser/API clients establish a cookie through `/api/auth/register` or `/api/auth/login`, include credentials on subsequent requests, and send `X-StudyPal-Request: 1` on every mutation. Usernames are registration/login/profile attributes. Ownership always comes from `req.user.id`. Anonymous feature clients receive 401 and conflicting compatibility username assertions receive 403.

SP-V2-009 applied migration 006 to the identified local development database after a verified backup. See [production-auth-verification](sp-v2-009-production-auth-verification.md) for the exact environment, real-data checks, retained verification identities and remaining production gates. This does not establish a public production deployment.
