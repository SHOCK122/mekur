-- Capability-based access model. See docs/ARCHITECTURE.md.
--
-- The defining property: no table here associates a user with an event.
-- Access is proven by presenting a capability token, not by matching an
-- identity against an access list. A breach of this schema yields
-- encrypted blobs and token hashes with nothing linking them to accounts.

-- The old model linked users to events directly and stored the social
-- graph in plaintext. There is no migration path that preserves that data
-- without preserving the leak, and test data is expendable, so these are
-- dropped outright rather than carried forward.
DROP TABLE IF EXISTS group_event_votes;
DROP TABLE IF EXISTS group_event_participants;
DROP TABLE IF EXISTS group_events;
DROP TABLE IF EXISTS events;

-- Unified event model: personal and group events are the same thing. A
-- "personal" event is simply one whose capability has been granted to a
-- single person. Slots and voting are optional and absent unless
-- scheduling is wanted.
--
-- Deliberately absent: any owner_id, creator_id, or participant list.
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Encrypted payload: title, description, location, start/end (both
    -- optional), recurrence rule, recurrence exceptions, priority rank,
    -- and the "important" flag. The server interprets none of it.
    envelope JSONB NOT NULL,
    -- Opaque candidate slot IDs, present only for events being scheduled.
    -- The server never learns what times these correspond to.
    slot_ids TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolved_slot_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capability tokens. Only hashes are stored: a breach yields values that
-- cannot be replayed as capabilities, exactly as with API keys and
-- password auth verifiers elsewhere in this schema.
--
-- Note there is no user_id column. That absence is the entire point.
CREATE TABLE event_capabilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
    -- Reusable join codes are revocable and may expire. Revoking stops new
    -- use; it cannot retract a token already copied, which is why real
    -- revocation means re-keying the event (see ARCHITECTURE.md).
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_capabilities_event_id_idx ON event_capabilities (event_id);

-- Votes are cast under a per-event pseudonym derived client-side from the
-- voter's capability, never a global user id. The server sees N
-- pseudonymous voters per event and cannot link the same person across
-- two events.
CREATE TABLE event_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    voter_pseudonym TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    rank INTEGER NOT NULL CHECK (rank > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, voter_pseudonym, slot_id)
);

CREATE INDEX event_votes_event_id_idx ON event_votes (event_id);

-- The keyring: one opaque encrypted blob per account, holding the list of
-- events that account can reach along with their tokens and keys. This is
-- what makes "list my events" possible without the server knowing the
-- answer.
--
-- The server learns approximately how many events an account has, from the
-- blob's size. That is the single leak accepted by design.
CREATE TABLE keyrings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    envelope JSONB NOT NULL,
    -- Optimistic concurrency: a client must present the version it read,
    -- so two devices writing concurrently cannot silently clobber each
    -- other and lose access to events.
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbox for delivering capabilities. Each row is encrypted to the
-- recipient's public key and contains the event id and tokens.
--
-- There is deliberately no sender column. Recording one would rebuild the
-- social graph in this very table. Sender identity, when disclosed at all,
-- travels *inside* the encrypted payload, where only the recipient can
-- read it -- which is also what lets blocking work client-side.
CREATE TABLE inbox_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    envelope JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inbox_messages_recipient_id_idx ON inbox_messages (recipient_id, created_at DESC);
