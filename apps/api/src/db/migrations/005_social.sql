-- One-time anonymous friend codes.
--
-- A user has at most one *active* code at a time. When someone tags them
-- with it, the code is consumed and a fresh one is issued, so a code can
-- never be reused to reach the same person twice. Codes are deliberately
-- unlinkable to the owner from the outside: the only way to resolve one is
-- to present it, and doing so consumes it.
CREATE TABLE friend_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    consumed_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Only one un-consumed code per user, enforced in the database rather than
-- trusted to application logic.
CREATE UNIQUE INDEX friend_codes_one_active_per_user
    ON friend_codes (user_id) WHERE consumed_at IS NULL;

CREATE INDEX friend_codes_user_id_idx ON friend_codes (user_id);

-- Directional relationships. A connection or block is something *you*
-- assert about someone else; it does not require their agreement, and
-- blocking must work regardless of what the other person wants.
CREATE TABLE user_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('connected', 'blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, other_user_id),
    CHECK (user_id <> other_user_id)
);

CREATE INDEX user_relationships_user_id_idx ON user_relationships (user_id);

-- Invitation responses, plus whether the invite arrived via a one-time
-- code. invited_via_code is what enforces the privacy rule: if someone
-- reached you through an anonymous code, neither side may turn that into a
-- lasting connection, because the whole point of the code was that it
-- didn't reveal an identity worth connecting to.
ALTER TABLE group_event_participants
    ADD COLUMN invite_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (invite_status IN ('pending', 'accepted', 'rejected')),
    ADD COLUMN invited_via_code BOOLEAN NOT NULL DEFAULT FALSE;

-- The organizer is a participant of their own event and never needs to
-- accept an invitation to it.
UPDATE group_event_participants gep
SET invite_status = 'accepted'
FROM group_events ge
WHERE gep.group_event_id = ge.id AND gep.user_id = ge.organizer_id;
