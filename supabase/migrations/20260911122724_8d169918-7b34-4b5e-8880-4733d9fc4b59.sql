INSERT INTO public.research_profiles (slug, name, description) VALUES (
  'auramaris-legal-compliance',
  'Auramaris Legal Compliance',
  'Legal and regulatory compliance research for the Auramaris consumer app.'
);

INSERT INTO public.research_profile_tier_policies (profile_id, version, policy, exposure, is_active)
SELECT
  p.id,
  1,
  '{
    "schema_version": 1,
    "default_tier": "T5",
    "rules": [
      {"tier": "T1", "when": {"op": "and", "children": [
        {"field": "is_official_domain", "operator": "is_true"},
        {"field": "is_primary_document", "operator": "is_true"},
        {"field": "traceability_level", "operator": "eq", "value": "direct_url"}
      ]}},
      {"tier": "T2", "when": {"op": "and", "children": [
        {"field": "is_official_domain", "operator": "is_true"},
        {"field": "traceability_level", "operator": "in", "value": ["direct_url", "domain_indicated"]},
        {"field": "is_primary_document", "operator": "is_false"}
      ]}},
      {"tier": "T3", "when": {"op": "and", "children": [
        {"field": "is_official_domain", "operator": "is_false"},
        {"field": "institution_class", "operator": "in", "value": ["government", "intergovernmental", "court", "academic", "professional_body", "registered_media"]}
      ]}},
      {"tier": "T4", "when": {"op": "and", "children": [
        {"field": "traceability_level", "operator": "in", "value": ["third_party_hosted", "domain_indicated"]}
      ]}}
    ]
  }'::jsonb,
  '{
    "schema_version": 1,
    "visible_tiers": ["T1", "T2", "T3", "T4"],
    "hidden_tiers_require_promotion": ["T5"]
  }'::jsonb,
  true
FROM public.research_profiles p
WHERE p.slug = 'auramaris-legal-compliance';