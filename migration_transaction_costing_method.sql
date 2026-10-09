-- Store the single valuation method selected for each new stock-out transaction.
-- Existing rows stay NULL and are treated as historical dual-cost records.
ALTER TABLE inventory_transactions
    ADD COLUMN costing_method VARCHAR(10) NULL AFTER fifo_layers;
