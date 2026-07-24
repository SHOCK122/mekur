-- API keys let agentic/programmatic clients authenticate without a
-- human login flow. Only a hash of the key is stored (same principle as
-- auth_hash for passwords): a DB leak doesn't hand out usable keys.
-- key_prefix is stored in the clear purely so a user can tell their keys
-- apart in a list without ever seeing the full key again.
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);
