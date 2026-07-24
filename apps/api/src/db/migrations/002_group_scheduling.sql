-- Group scheduling: the organizer proposes opaque candidate slot IDs and
-- an encrypted content blob (title/description/real slot times, wrapped
-- under a per-event key). The server never sees slot times or content --
-- only slot IDs, participant IDs, and each participant's rank of each
-- slot ID. See docs/ARCHITECTURE.md for the full design.

CREATE TABLE group_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_ids TEXT[] NOT NULL,
    content_envelope JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolved_slot_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per participant (the organizer included -- see design note in
-- packages/shared), holding that participant's own wrapped copy of the
-- event key. The server can relay this but never has a key that opens it.
CREATE TABLE group_event_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_event_id UUID NOT NULL REFERENCES group_events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_key JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_event_id, user_id)
);

CREATE INDEX group_event_participants_user_id_idx ON group_event_participants (user_id);

-- One row per (event, voter, slot): a voter's rank for that slot. A voter
-- need not rank every slot.
CREATE TABLE group_event_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_event_id UUID NOT NULL REFERENCES group_events(id) ON DELETE CASCADE,
    voter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_id TEXT NOT NULL,
    rank INTEGER NOT NULL CHECK (rank > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_event_id, voter_id, slot_id)
);

CREATE INDEX group_event_votes_group_event_id_idx ON group_event_votes (group_event_id);
