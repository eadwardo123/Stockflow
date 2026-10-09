-- Align older auto-generated journal rows with their existing payment state.
UPDATE financial_journal
SET payment_status = CASE
        WHEN `type` = 'SALE' THEN COALESCE(NULLIF(paid_status, 'Not applicable'), 'Unpaid')
        WHEN `type` IN ('PURCHASE', 'CUSTOMER_RETURN') THEN COALESCE(NULLIF(paid_status, 'Not applicable'), 'Unpaid')
        ELSE payment_status
    END,
    paid_status = CASE
        WHEN `type` = 'SALE' THEN COALESCE(NULLIF(paid_status, 'Not applicable'), 'Unpaid')
        WHEN `type` IN ('PURCHASE', 'CUSTOMER_RETURN') THEN COALESCE(NULLIF(paid_status, 'Not applicable'), 'Unpaid')
        ELSE paid_status
    END,
    remaining_debt = CASE
        WHEN `type` IN ('PURCHASE', 'CUSTOMER_RETURN')
             AND remaining_debt IS NULL AND total_purchase_price > 0
        THEN total_purchase_price
        ELSE remaining_debt
    END
WHERE source_transaction_id IS NOT NULL;
