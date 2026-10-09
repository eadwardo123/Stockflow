-- FIFO cost-layer migration. Run after migration_wac.sql.

CREATE TABLE IF NOT EXISTS inventory_cost_layers (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    item_id           INT NOT NULL,
    warehouse_id      INT NOT NULL,
    shelf_id          INT NOT NULL,
    quantity          DECIMAL(15,3) NOT NULL,
    remaining_quantity DECIMAL(15,3) NOT NULL,
    unit_cost         DECIMAL(15,4) NOT NULL DEFAULT 0,
    reference_number  VARCHAR(100),
    received_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES items(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouse(id),
    FOREIGN KEY (shelf_id) REFERENCES shelves(id),
    INDEX idx_fifo_order (item_id, warehouse_id, shelf_id, remaining_quantity, received_at, id)
);

ALTER TABLE inventory_transactions
    ADD COLUMN fifo_cogs DECIMAL(15,4) NULL AFTER cogs,
    ADD COLUMN fifo_layers TEXT NULL AFTER fifo_cogs;

-- Preserve existing stock as one FIFO layer per shelf at its current WAC.
INSERT INTO inventory_cost_layers
    (item_id, warehouse_id, shelf_id, quantity, remaining_quantity, unit_cost, reference_number)
SELECT inv.item_id, inv.warehouse_id, inv.shelf_id, inv.quantity, inv.quantity,
       COALESCE(ic.avg_cost, 0), 'FIFO migration'
FROM inventory inv
LEFT JOIN item_costs ic ON ic.item_id = inv.item_id
WHERE inv.quantity > 0
  AND NOT EXISTS (
      SELECT 1
      FROM inventory_cost_layers layer
      WHERE layer.item_id = inv.item_id
        AND layer.warehouse_id = inv.warehouse_id
        AND layer.shelf_id = inv.shelf_id
  );
