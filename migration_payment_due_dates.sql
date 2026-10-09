-- Add optional deadlines for outstanding purchase payables and sale receivables.
ALTER TABLE financial_journal
    ADD COLUMN purchase_due_date DATE NULL AFTER purchase_settlement_date,
    ADD COLUMN sale_due_date DATE NULL AFTER sale_settlement_date;
