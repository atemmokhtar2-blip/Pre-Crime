-- Pre-Crime initial PostgreSQL schema.
-- Apply through a migration tool after provisioning the production database.

CREATE TABLE IF NOT EXISTS app_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE,
  username TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  chat_id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  username TEXT,
  chat_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','left')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_admins (
  chat_id BIGINT NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','administrator','moderator','analyst')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_members (
  chat_id BIGINT NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'member' CHECK (status IN ('member','restricted','left','banned')),
  joined_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  message_count BIGINT NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chat_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS group_settings (
  chat_id BIGINT PRIMARY KEY REFERENCES groups(chat_id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id BIGINT PRIMARY KEY,
  update_type TEXT NOT NULL,
  chat_id BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','failed')),
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  target_telegram_user_id BIGINT NOT NULL,
  actor_telegram_user_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warnings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
  target_telegram_user_id BIGINT NOT NULL,
  actor_telegram_user_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT REFERENCES groups(chat_id) ON DELETE SET NULL,
  actor_telegram_user_id BIGINT,
  actor_app_user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS group_members_status_idx ON group_members(chat_id, status);
CREATE INDEX IF NOT EXISTS group_members_activity_idx ON group_members(chat_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS moderation_actions_group_created_idx ON moderation_actions(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_group_created_idx ON audit_events(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_updates_status_idx ON telegram_updates(status, received_at);
