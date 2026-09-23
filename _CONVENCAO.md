# OryxScrape — Convenção de Nomenclatura e Estrutura de Dado

> **Este arquivo é fonte de verdade para nomenclatura e convenções do projeto.**
> Qualquer nova tabela, campo, enum, job ou source criado deve seguir estas regras.
> Editar aqui antes de criar no código — nunca o contrário.
>
> Última revisão: 2026-09-23

---

## 1. Nomenclatura geral

| Elemento | Padrão | Exemplo |
|---|---|---|
| Tabelas | `snake_case`, plural | `raw_items`, `normalized_items` |
| Colunas | `snake_case` | `source_url`, `collected_at` |
| Enums PostgreSQL | `snake_case` sem sufixo `_type` | `collection_method`, `traceability_level` |
| Funções PG | `snake_case`, verbo no infinitivo | `get_feed_items()` |
| Roles PG | `snake_case` com prefixo de papel | `consumer_readonly`, `staff_readwrite` |
| Arquivos TypeScript (servidor) | `kebab-case.server.ts` | `fek.server.ts`, `fek-collect.server.ts` |
| Arquivos TypeScript (rotas API) | `kebab-case.ts` dentro de `routes/api/` | `items.ts`, `collect.ts` |
| Variáveis de ambiente | `UPPER_SNAKE_CASE` | `APIFY_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` |

---

## 2. Tabelas — mapa de responsabilidade

| Tabela | Papel | Mutável? |
|---|---|---|
| `sources` | Cadastro de sites/APIs-alvo com metadados de ToS, robots, tier de origem | Sim (metadados atualizados periodicamente) |
| `collection_jobs` | Registro de cada rodada de coleta (um job por execução) | Não (após conclusão) |
| `raw_items` | Payload bruto imutável + hash de dedup + proveniência completa | **Nunca** |
| `normalized_items` | Versão limpa/estruturada; é o manifest exposto pela API | Sim (revisão humana) |
| `normalized_item_profile_exposure` | Relaciona `normalized_items` com `research_profiles` que devem ver o item | Sim |
| `research_profiles` | Perfis de consumo (ex: "auramaris-nautical-gr") | Sim |
| `research_profile_tier_policies` | Versões de política de tier por perfil — **nunca sobrescrever, apenas inserir nova versão** | Não (append-only) |
| `consumer_keys` | Chaves de API por app consumidor, escopadas por tags | Sim |
| `search_terms` | Termos de busca com ciclo de vida controlado | Sim |
| `exchange_handoffs` | Registro de cada entrega de item ao consumidor via API | Não |
| `exchange_suppressions` | Lista de supressões de dedup para evitar reentrega | Não |
| `audit_events` | Log imutável de auditoria de toda mudança relevante | **Nunca** |
| `staff_members` | Usuários internos com role (owner/staff) | Sim |

---

## 3. Enums definidos — valores canônicos

### `collection_method`
| Valor | Quando usar |
|---|---|
| `apify` | Coleta via actor Apify |
| `http` | Fetch HTTP direto (sem Apify, sem autenticação) |
| `api` | API oficial do site-alvo (ex: et.gr JSON API) |
| `manual` | Upload manual por staff |

### `traceability_level`
| Valor | Significado |
|---|---|
| `direct_url` | URL do documento original disponível e verificável |
| `domain_indicated` | Domínio oficial identificado, mas URL exata não direta |
| `third_party_hosted` | Documento em site que não é o emissor oficial |
| `untraceable` | Origem não rastreável |

### `institution_class`
| Valor | Exemplos |
|---|---|
| `government` | Imprensa oficial, ministérios, órgãos reguladores |
| `intergovernmental` | IMO, EU, EMSA |
| `court` | Tribunais |
| `academic` | Universidades, institutos de pesquisa |
| `professional_body` | Ordens profissionais, associações |
| `registered_media` | Veículo de comunicação registrado |
| `commercial` | Empresa privada sem status oficial |
| `unknown` | Não classificado |

### `tier_label` (para `research_profile_tier_policies`)
| Valor | Interpretação padrão |
|---|---|
| `T1` | Fonte primária oficial — máxima confiabilidade |
| `T2` | Fonte secundária confiável (ex: consolidação jurídica reconhecida) |
| `T3` | Fonte terciária ou agregador (ex: Taxheaven com paywall) |
| `T4` | Fonte comercial sem verificação editorial |
| `T5` | Não classificada / uso restrito |

### `job_status`
`queued` → `running` → `succeeded` | `failed` | `cancelled`

### `verification_status` (em `normalized_items`)
| Valor | Significado |
|---|---|
| `unreviewed` | Ainda não revisado por staff |
| `reviewed` | Revisado e aprovado |
| `rejected` | Rejeitado — não deve ser exposto |

### `publication_status` (em `normalized_items`)
| Valor | Significado |
|---|---|
| `internal_only` | Visível só internamente |
| `eligible` | Elegível para entrega via API ao consumidor |

### `search_term_lifecycle`
`candidate` → `promising` → `validated` | `ambiguous` | `cooldown` | `disabled_auto` | `manual_only` | `deprecated`

---

## 4. Campos de proveniência obrigatórios em `raw_items`

Todo item coletado **deve** ter:
- `source_url` — URL exata de onde o item foi coletado
- `canonical_url` — URL canônica (pode ser igual a `source_url`)
- `collected_at` — timestamp UTC do momento da coleta
- `collection_method` — enum acima
- `raw_payload` — payload bruto JSONB imutável
- `content_hash` — SHA-256 do payload (para dedup)
- `is_official_domain` — booleano (derivado da `sources`)
- `traceability_level` — enum acima
- `collector_version` — string identificando a versão do collector (ex: `etgr-fek-api@1.0.0`)

---

## 5. Convenção de nomeação de sources

Formato: `{Nome Oficial} — {País ou Contexto}`

Exemplos corretos:
- `Εθνικό Τυπογραφείο — ΦΕΚ (Greece)`
- `BOE — Boletín Oficial del Estado`
- `Diário da República — Portugal`

**Não usar abreviações sozinhas** como nome: usar `et.gr` é o `domain`, não o `name`.

---

## 6. Convenção de nomeação de collection_jobs

Formato livre no campo `notes`, mas o `source_id` + `started_at` identificam o job unicamente.
Cada job é atômico: uma fonte, um período de coleta.

---

## 7. Variáveis de ambiente necessárias

| Variável | Onde configurar | Status |
|---|---|---|
| `SUPABASE_URL` | Lovable / Supabase dashboard | ✅ Configurado |
| `SUPABASE_ANON_KEY` | Lovable / Supabase dashboard | ✅ Configurado |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Functions secrets | ✅ Configurado |
| `APIFY_API_TOKEN` | Supabase vault / Edge Functions secrets | ✅ Configurado |

---

## 8. Regras de segurança — aplicadas desde o início

1. **RLS habilitada em toda tabela nova** — sem exceção.
2. Toda função nova começa com `REVOKE ALL ON FUNCTION ... FROM PUBLIC` + `GRANT` explícito.
3. `SECURITY DEFINER` só com `search_path` travado e justificativa em comentário SQL.
4. Mudança de schema sempre em branch Supabase separado — nunca direto em produção.
5. `get_advisors` rodado após cada bloco de mudança de schema.

---

## 9. Regras de isolamento entre projetos

- OryxScrape **nunca** tem credencial de escrita em banco de consumidor.
- Consumidores só acessam via `GET /api/public/v1/items` com `consumer_key`.
- Nenhuma menção ao nome "OryxScrape" no código de consumidor — só variável genérica (ex: `REGULATORY_FEED_API_URL`).

---

## 10. Histórico de revisões deste arquivo

| Data | Autor | Mudança |
|---|---|---|
| 2026-09-23 | Rogerio / Claude | Criação inicial — derivada do schema real do banco (29 migrations) |
| 2026-09-23 | Rogerio / Claude | APIFY_API_TOKEN marcado como ✅ Configurado |
