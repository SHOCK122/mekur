-- Users: only public-key material and an auth verifier are stored.
-- The server never sees a user's password or their symmetric encryption key.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    public_key TEXT NOT NULL,       -- base64 X25519 public key
    auth_salt TEXT NOT NULL,        -- base64 scrypt salt used to derive the auth key
    auth_hash TEXT NOT NULL,        -- base64 sha256(authKey); never the password or encryption key
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Events: content is an opaque EncryptedEnvelope. The server cannot read
-- titles, times, locations, or descriptions -- only structural metadata
-- needed to store and route the record.
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    envelope JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_owner_id_idx ON events (owner_id);
