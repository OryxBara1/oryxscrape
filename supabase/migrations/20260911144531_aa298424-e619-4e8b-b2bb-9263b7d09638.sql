ALTER VIEW public.staff_item_tier_matrix SET (security_invoker = true);
REVOKE ALL ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eval_policy_node(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.eval_policy_node(jsonb, jsonb) TO authenticated, service_role;