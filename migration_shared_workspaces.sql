-- Allow multiple user accounts to share one workspace database.
ALTER TABLE app_user_workspaces
    DROP INDEX database_name,
    ADD COLUMN role ENUM('owner', 'admin', 'staff') NOT NULL DEFAULT 'owner' AFTER database_name,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER role,
    ADD INDEX idx_app_user_workspaces_database_name (database_name);

-- Existing user-to-database mappings remain intact and are owners by default.
CREATE TABLE IF NOT EXISTS app_workspace_invites (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    database_name VARCHAR(64) NOT NULL,
    role ENUM('admin', 'staff') NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    accepted_by BIGINT UNSIGNED NULL,
    accepted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_app_workspace_invites_database_name (database_name),
    CONSTRAINT fk_app_workspace_invites_creator
        FOREIGN KEY (created_by) REFERENCES app_users(id),
    CONSTRAINT fk_app_workspace_invites_accepted_user
        FOREIGN KEY (accepted_by) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
