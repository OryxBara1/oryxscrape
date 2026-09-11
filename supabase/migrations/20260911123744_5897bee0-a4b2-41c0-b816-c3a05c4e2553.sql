REVOKE EXECUTE ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.eval_policy_node(jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) FROM anon;