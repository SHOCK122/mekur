-- Web Push subscriptions. A user may have multiple (one per
-- browser/device). Endpoint is unique: re-subscribing the same
-- browser/device updates its keys rather than creating a duplicate row.
CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);
