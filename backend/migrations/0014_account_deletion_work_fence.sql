CREATE TRIGGER IF NOT EXISTS external_ai_work_leases_block_account_deletion
BEFORE INSERT ON external_ai_work_leases
WHEN EXISTS (
  SELECT 1 FROM account_deletion_jobs
  WHERE user_id = NEW.user_id AND status IN ('pending', 'processing')
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_in_progress');
END;

CREATE TRIGGER IF NOT EXISTS soniox_work_leases_block_account_deletion
BEFORE INSERT ON soniox_work_leases
WHEN EXISTS (
  SELECT 1 FROM account_deletion_jobs
  WHERE user_id = NEW.user_id AND status IN ('pending', 'processing')
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_in_progress');
END;
