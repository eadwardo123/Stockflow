-- Item production details and printable sales invoice fields.

ALTER TABLE purchase_order_items
    ADD COLUMN production_date DATE NULL AFTER unit_cost;

ALTER TABLE inventory_cost_layers
    ADD COLUMN production_date DATE NULL AFTER received_at;

ALTER TABLE inventory_transactions
    ADD COLUMN customer_name VARCHAR(255) NULL AFTER notes,
    ADD COLUMN sale_price DECIMAL(15,4) NULL AFTER customer_name,
    ADD COLUMN tax_pct DECIMAL(7,3) NULL AFTER sale_price,
    ADD COLUMN discount_amount DECIMAL(15,4) NULL AFTER tax_pct,
    ADD COLUMN production_date DATE NULL AFTER discount_amount;
