-- ============================================================
-- WAC (Weighted Average Cost) migration
-- Run once against your database.
-- ============================================================

-- 1. Item cost ledger: one row per item, holds current avg cost and markup %.
CREATE TABLE IF NOT EXISTS item_costs (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    item_id     INT NOT NULL UNIQUE,
    avg_cost    DECIMAL(15,4) NOT NULL DEFAULT 0,
    markup_pct  DECIMAL(7,2)  NOT NULL DEFAULT 30,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES items(id)
);

-- 2. Add cost columns to the transaction ledger.
--    unit_cost = average cost at the time of the transaction
--    cogs      = unit_cost × quantity  (populated for OUT/SELL rows)
ALTER TABLE inventory_transactions
    ADD COLUMN unit_cost DECIMAL(15,4) NULL AFTER quantity,
    ADD COLUMN cogs      DECIMAL(15,4) NULL AFTER unit_cost;

