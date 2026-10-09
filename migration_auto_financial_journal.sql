-- Link automatically generated financial journal entries to inventory transactions.
ALTER TABLE financial_journal
    ADD COLUMN source_transaction_id BIGINT NULL,
    ADD UNIQUE INDEX uq_financial_journal_source_transaction (source_transaction_id);

ALTER TABLE financial_journal
    MODIFY remaining_debt DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY remaining_receivables DECIMAL(15,4) NULL DEFAULT NULL;
