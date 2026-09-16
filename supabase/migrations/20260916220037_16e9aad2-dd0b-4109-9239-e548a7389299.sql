ALTER TYPE public.exchange_handoff_state ADD VALUE IF NOT EXISTS 'duplicate';
ALTER TYPE public.exchange_handoff_state ADD VALUE IF NOT EXISTS 'superseded';
ALTER TYPE public.audit_check_type ADD VALUE IF NOT EXISTS 'exchange_feedback';