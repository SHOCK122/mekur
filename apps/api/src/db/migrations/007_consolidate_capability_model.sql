-- Consolidation pass on the capability model. See docs/ROADMAP.md, Phase 7.

-- Group-scheduling scaffolding with no routes behind it. Slots and votes
-- will come back with the feature (roadmap Phase 10), designed then rather
-- than kept half-built now.
DROP TABLE IF EXISTS event_votes;
ALTER TABLE events
    DROP COLUMN IF EXISTS slot_ids,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS resolved_slot_id;

-- Server-side connections/blocks from the ACL era. Under the capability
-- model blocking is client-side and the server must not hold a social
-- graph; nothing has written to this table since migration 006.
DROP TABLE IF EXISTS user_relationships;

-- friend_codes.consumed_by recorded who redeemed whose code -- a plaintext
-- edge in exactly the social graph the capability model avoids storing.
-- Spent codes are now simply deleted, so a user has exactly one row: their
-- current code.
DELETE FROM friend_codes WHERE consumed_at IS NOT NULL;
DROP INDEX IF EXISTS friend_codes_one_active_per_user;
DROP INDEX IF EXISTS friend_codes_user_id_idx;
ALTER TABLE friend_codes
    DROP COLUMN IF EXISTS consumed_at,
    DROP COLUMN IF EXISTS consumed_by,
    DROP COLUMN IF EXISTS id,
    ADD PRIMARY KEY (user_id);
