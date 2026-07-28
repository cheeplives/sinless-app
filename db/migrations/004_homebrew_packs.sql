-- 004_homebrew_packs.sql — named, shareable homebrew packs + subscriptions.
-- Run ONCE against an existing database:
--   mysql -h <host> -u <user> -p <db> < db/migrations/004_homebrew_packs.sql
-- (Fresh installs get these tables from db/schema.sql already.)
--
-- The legacy per-user custom_content blob is KEPT (safe rollback); this migration
-- copies each user's blob into a starter pack named "My Homebrew". Re-running the
-- INSERT would duplicate those packs, so run this file only once.

CREATE TABLE IF NOT EXISTS homebrew_packs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120) NOT NULL DEFAULT 'Homebrew',
  data        LONGTEXT     NOT NULL,               -- {tableKey: [rows...]} JSON (opaque)
  is_public   TINYINT(1)   NOT NULL DEFAULT 0,     -- 1 = visible to other members
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user (user_id),
  KEY idx_public (is_public),
  CONSTRAINT fk_hbpacks_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS homebrew_subscriptions (
  user_id     BIGINT UNSIGNED NOT NULL,
  pack_id     BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, pack_id),
  KEY idx_pack (pack_id),
  CONSTRAINT fk_hbsub_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_hbsub_pack FOREIGN KEY (pack_id)
    REFERENCES homebrew_packs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fold each user's existing homebrew blob into a starter pack (run once).
INSERT INTO homebrew_packs (user_id, name, data, is_public)
  SELECT user_id, 'My Homebrew', data, 0 FROM custom_content;
