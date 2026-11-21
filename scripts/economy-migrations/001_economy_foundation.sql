-- cunvrs economy foundation — DEVELOPMENT / RESTORED TEST DATABASE FIRST.
-- Additive only: does not modify existing economy rows, legacy bank balances,
-- existing ticket_data, or schema_migrations version.
-- Review the actual DB schema/version and test on a restored copy before production.
BEGIN;

-- Append-only financial events. A globally unique operation_id makes retries idempotent.
CREATE TABLE IF NOT EXISTS cunvrs_economy_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    actor_id VARCHAR(20),
    event_type VARCHAR(64) NOT NULL,
    amount BIGINT NOT NULL DEFAULT 0,
    balance_before BIGINT NOT NULL CHECK (balance_before >= 0),
    balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cunvrs_ledger_balance_math CHECK (balance_after = balance_before + amount),
    CONSTRAINT cunvrs_ledger_guild_fk FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT,
    CONSTRAINT cunvrs_ledger_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cunvrs_ledger_user_time ON cunvrs_economy_ledger (guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cunvrs_ledger_type_time ON cunvrs_economy_ledger (guild_id, event_type, created_at DESC);

-- Cached daily repeatable earnings; calendar date is computed in America/Detroit
-- by the transactional service (not by UTC date strings).
CREATE TABLE IF NOT EXISTS cunvrs_economy_daily_limits (
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    local_day DATE NOT NULL,
    repeatable_coins INTEGER NOT NULL DEFAULT 0 CHECK (repeatable_coins BETWEEN 0 AND 5000),
    minigame_coins INTEGER NOT NULL DEFAULT 0 CHECK (minigame_coins BETWEEN 0 AND 1500),
    work_shifts INTEGER NOT NULL DEFAULT 0 CHECK (work_shifts BETWEEN 0 AND 10),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id, local_day),
    CONSTRAINT cunvrs_daily_minigame_subset CHECK (minigame_coins <= repeatable_coins),
    CONSTRAINT cunvrs_daily_guild_fk FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT,
    CONSTRAINT cunvrs_daily_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- Non-transferable redemption tickets: 1 UGC / 2 Robux / 1 VIP issued every 168h.
CREATE TABLE IF NOT EXISTS cunvrs_redemption_ticket_balances (
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    ticket_type VARCHAR(12) NOT NULL CHECK (ticket_type IN ('ugc', 'robux', 'vip')),
    available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id, ticket_type),
    CONSTRAINT cunvrs_tickets_guild_fk FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT,
    CONSTRAINT cunvrs_tickets_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- The verified Ticketcord channel-owner association must be established by
-- a trusted process; a channel permission override alone is insufficient proof.
CREATE TABLE IF NOT EXISTS cunvrs_ticketcord_owners (
    guild_id VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) PRIMARY KEY,
    owner_id VARCHAR(20) NOT NULL,
    verified_by VARCHAR(20) NOT NULL,
    verification_method VARCHAR(64) NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cunvrs_ticketcord_guild_fk FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT,
    CONSTRAINT cunvrs_ticketcord_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- Request lifecycle and holds are managed atomically by the future service.
CREATE TABLE IF NOT EXISTS cunvrs_redemptions (
    id UUID PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    item_code VARCHAR(80) NOT NULL,
    ticket_type VARCHAR(12) NOT NULL CHECK (ticket_type IN ('ugc', 'robux', 'vip')),
    coins_reserved BIGINT NOT NULL CHECK (coins_reserved >= 0),
    status VARCHAR(32) NOT NULL CHECK (status IN (
        'pending_approval', 'approved', 'in_progress', 'delivered',
        'declined', 'cancelled', 'disputed', 'resolved'
    )),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT cunvrs_redemption_guild_fk FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT,
    CONSTRAINT cunvrs_redemption_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
-- Exactly one pending-approval redemption per member; subsequent approved
-- fulfilments are tracked separately, consistent with the finalized policy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cunvrs_one_pending_redemption
    ON cunvrs_redemptions(guild_id, user_id) WHERE status = 'pending_approval';
CREATE INDEX IF NOT EXISTS idx_cunvrs_redemptions_user
    ON cunvrs_redemptions(guild_id, user_id, requested_at DESC);

COMMIT;
