-- Rollback of 0020_bank_statements. Only safe before any statement is imported. Take a backup first.

-- payments_guard: back to the 0017 rules.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keep text[] := ARRAY['status','countedOn','countedBy','countedByName','reversedAt','reversedBy','reversedByName','reversalReason'];
BEGIN
  IF coalesce(current_setting('shayona.restore', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payments are never deleted. Reverse the payment instead.'; END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'returned'))
       OR (OLD.status = 'active'  AND NEW.status IN ('bounced', 'reversed')))
     OR (to_jsonb(NEW) - keep) IS DISTINCT FROM (to_jsonb(OLD) - keep)
     OR (OLD."countedOn" IS NOT NULL AND NEW."countedOn" IS DISTINCT FROM OLD."countedOn") THEN
    RAISE EXCEPTION 'payments cannot be edited; only the status moves pending → deposited / returned, deposited → bounced / reversed.';
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS payments_statement_line_idx;
ALTER TABLE payments DROP COLUMN IF EXISTS "statementLineId";
DROP TABLE IF EXISTS payer_aliases;
DROP TABLE IF EXISTS bank_statement_lines;
DROP TABLE IF EXISTS bank_statement_imports;
ALTER TABLE bank_accounts DROP COLUMN IF EXISTS "statementColumns";
