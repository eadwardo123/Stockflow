ALTER TABLE inventory
    MODIFY quantity DECIMAL(15,4) NOT NULL DEFAULT 0;

ALTER TABLE inventory_transactions
    MODIFY quantity DECIMAL(15,4) NOT NULL;

ALTER TABLE inventory_cost_layers
    MODIFY quantity DECIMAL(15,4) NOT NULL,
    MODIFY remaining_quantity DECIMAL(15,4) NOT NULL;