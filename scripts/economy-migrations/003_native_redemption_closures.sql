-- Native redemption ticket closing protection.
-- Apply to isolated restored database and test first.
-- Do not apply to production until final deployment review.

BEGIN;

CREATE TABLE IF NOT EXISTS cunvrs_native_redemption_closures (
  guild_id VARCHAR(20) NOT NULL,
  channel_id VARCHAR(20) NOT NULL,
  owner_id VARCHAR(20) NOT NULL,
  state VARCHAR(20) NOT NULL
    CHECK (state IN ('closing', 'archived', 'closed')),
  started_by VARCHAR(20) NOT NULL,
  archive_message_id VARCHAR(20),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id),
  FOREIGN KEY (guild_id)
    REFERENCES guilds(id) ON DELETE RESTRICT
);

COMMIT;
