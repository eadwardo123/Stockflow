-- Allow automatic journal rows to leave the non-applicable trade side empty.
ALTER TABLE financial_journal
    MODIFY purchase_price_per_unit DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY total_purchase_price DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY remaining_debt DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY selling_price_per_unit DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY total_selling_price DECIMAL(15,4) NULL DEFAULT NULL,
    MODIFY remaining_receivables DECIMAL(15,4) NULL DEFAULT NULL;

UPDATE financial_journal
SET purchase_price_per_unit = NULL,
    total_purchase_price = NULL,
    purchase_settlement_date = NULL,
    remaining_debt = NULL
WHERE source_transaction_id IS NOT NULL
  AND `type` = 'SALE';

UPDATE financial_journal
SET selling_price_per_unit = NULL,
    total_selling_price = NULL,
    sale_settlement_date = NULL,
    remaining_receivables = NULL
WHERE source_transaction_id IS NOT NULL
  AND `type` = 'PURCHASE';
