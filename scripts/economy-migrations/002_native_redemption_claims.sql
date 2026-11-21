CREATE TABLE IF NOT EXISTS cunvrs_native_redemption_claims (
    channel_id VARCHAR(20) PRIMARY KEY
        REFERENCES cunvrs_ticketcord_owners(channel_id)
        ON DELETE CASCADE,
    claimed_by VARCHAR(20) NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
