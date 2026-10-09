CREATE TABLE warehouse(
	id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
	warehouse_name VARCHAR(100) NOT NULL,
	address VARCHAR(255) NOT NULL,
	contact VARCHAR(13) NOT NULL,
	contact_name VARCHAR(255) NOT NULL,
	codes VARCHAR(255) NULL,
	email VARCHAR(255) NOT NULL UNIQUE,
	image TEXT NULL,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE shelves(
	id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
	warehouse_id INT NOT NULL,
	shelf_code VARCHAR(255) NOT NULL,
	shelf_block VARCHAR(100) NOT NULL,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   CONSTRAINT fk_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouse(id)
);


CREATE TABLE units(
	id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
	unit_name VARCHAR(255) NOT NULL,
	descriptions VARCHAR(255) NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE conversion(
	id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
	from_unit_id INT NOT NULL,
	to_unit_id INT NOT NULL,
	conversion_name VARCHAR(255) NOT NULL,
	conversion_value DOUBLE(10,2) NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   CONSTRAINT fk_from_unit_id FOREIGN KEY (from_unit_id ) REFERENCES units(id),
   CONSTRAINT fk_to_unit_id FOREIGN KEY (to_unit_id) REFERENCES units(id)
		
		
);

`inventory project`CREATE TABLE brands(
	id INT AUTO_INCREMENT PRIMARY KEY NOT NULL,
	brand_name VARCHAR(255) NOT NULL,
	brand_description VARCHAR(255) NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP	
);

CREATE TABLE items(
    id INT AUTO_INCREMENT PRIMARY KEY,
    brand_id INT NOT NULL,
    unit_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    item_code VARCHAR(255) NOT NULL UNIQUE,
    description VARCHAR(255),
    minimum_stock DECIMAL(15,3) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_item_brand
        FOREIGN KEY (brand_id) REFERENCES brands(id),

    CONSTRAINT fk_item_unit
        FOREIGN KEY (unit_id) REFERENCES units(id)
);

CREATE TABLE inventory(
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    shelf_id INT NOT NULL,
    quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_inventory_item
        FOREIGN KEY (item_id) REFERENCES items(id),

    CONSTRAINT fk_inventory_warehouse
        FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),

    CONSTRAINT fk_inventory_shelf
        FOREIGN KEY (shelf_id) REFERENCES shelves(id),

    UNIQUE(item_id, shelf_id)
);

CREATE TABLE inventory_transactions(
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT NOT NULL,
    warehouse_id INT NOT NULL,
    shelf_id INT NOT NULL,

    transaction_type ENUM(
        'IN',
        'OUT',
        'TRANSFER',
        'ADJUSTMENT'
    ) NOT NULL,

    quantity DECIMAL(15,3) NOT NULL,

    reference_number VARCHAR(100),
    notes VARCHAR(255),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (item_id) REFERENCES items(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
    FOREIGN KEY (shelf_id) REFERENCES shelves(id)
);

CREATE TABLE stock_transfers(
    id INT AUTO_INCREMENT PRIMARY KEY,
    transfer_number VARCHAR(100) NOT NULL UNIQUE,

    from_warehouse_id INT NOT NULL,
    to_warehouse_id INT NOT NULL,

    status ENUM('PENDING','COMPLETED','CANCELLED')
        DEFAULT 'PENDING',

    notes VARCHAR(255),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (from_warehouse_id) REFERENCES warehouse(id),
    FOREIGN KEY (to_warehouse_id) REFERENCES warehouse(id)
);

CREATE TABLE stock_transfer_items(
    id INT AUTO_INCREMENT PRIMARY KEY,
    transfer_id INT NOT NULL,
    item_id INT NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,

    FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id),
    FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE suppliers(
    id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_name VARCHAR(255) NOT NULL,
    contact VARCHAR(50),
    email VARCHAR(255),
    address VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_orders(
    id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_id INT NOT NULL,
    po_number VARCHAR(100) NOT NULL UNIQUE,
    po_date DATE NOT NULL,
    status ENUM('PENDING','RECEIVED','CANCELLED')
        DEFAULT 'PENDING',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE purchase_order_items(
    id INT AUTO_INCREMENT PRIMARY KEY,
    purchase_order_id INT NOT NULL,
    item_id INT NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,
    unit_cost DECIMAL(15,2) NOT NULL,

    FOREIGN KEY (purchase_order_id)
        REFERENCES purchase_orders(id),

    FOREIGN KEY (item_id)
        REFERENCES items(id)
);

CREATE TABLE app_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_workspace (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    owner_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_app_workspace_owner
        FOREIGN KEY (owner_user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_user_workspaces (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    database_name VARCHAR(64) NOT NULL,
    role ENUM('owner', 'admin', 'staff') NOT NULL DEFAULT 'owner',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_app_user_workspaces_database_name (database_name),
    CONSTRAINT fk_app_user_workspaces_user
        FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_workspace_invites (
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

CREATE TABLE workspace_onboarding (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    status ENUM('active', 'skipped', 'completed') NOT NULL DEFAULT 'active',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workspace_preferences (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    currency_code CHAR(3) NOT NULL DEFAULT 'IDR',
    language_code ENUM('en', 'id') NOT NULL DEFAULT 'en',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workspace_audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_user_id BIGINT UNSIGNED NOT NULL,
    actor_username VARCHAR(32) NOT NULL,
    actor_role ENUM('owner', 'admin', 'staff') NOT NULL,
    action VARCHAR(16) NOT NULL,
    resource VARCHAR(100) NOT NULL,
    target_id VARCHAR(100) NULL,
    status_code SMALLINT UNSIGNED NOT NULL,
    succeeded BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_workspace_audit_created_at (created_at),
    INDEX idx_workspace_audit_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
