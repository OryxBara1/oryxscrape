ALTER TYPE public.exchange_handoff_state ADD VALUE IF NOT EXISTS 'archived';
ALTER TYPE public.audit_check_type ADD VALUE IF NOT EXISTS 'exchange_archive';

ALTER TABLE public.exchange_handoffs
  ADD COLUMN IF NOT EXISTS processed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS processed_by uuid,
  ADD COLUMN IF NOT EXISTS processed_note text,
  ADD COLUMN IF NOT EXISTS drive_processed_folder_id text;