-- Preserve source-ledger fields that do not fit in the original 24 journal columns.
ALTER TABLE financial_journal
    ADD COLUMN quantity_in_kg DECIMAL(15,4) NULL,
    ADD COLUMN quantity_out_kg DECIMAL(15,4) NULL,
    ADD COLUMN purchase_amount_paid DECIMAL(15,4) NULL,
    ADD COLUMN sale_amount_received DECIMAL(15,4) NULL,
    ADD COLUMN commission_paid_status VARCHAR(50) NULL,
    ADD COLUMN import_reference VARCHAR(100) NULL,
    ADD UNIQUE INDEX uq_financial_journal_import_reference (import_reference);

ALTER TABLE financial_journal
    MODIFY quantity_kg DECIMAL(15,4) NOT NULL DEFAULT 0,
    MODIFY stock_remaining DECIMAL(15,3) NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS financial_journal_import_summaries (
    source_id VARCHAR(100) PRIMARY KEY,
    as_of_date DATE NOT NULL,
    row_count INT NOT NULL,
    totals JSON NOT NULL,
    balances JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
