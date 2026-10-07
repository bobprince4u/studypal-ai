-- Existing users stay locked until an operator provisions credentials.
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE TABLE auth_sessions (
 token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE auth_rate_limits (
 key TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);
COMMENT ON TABLE users IS 'Students with server-authenticated identity. NULL password_hash locks legacy accounts.';
