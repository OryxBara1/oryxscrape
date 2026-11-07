# Roadmap

## Correção da coleta manual italiana (2026-10-24)
- [x] Normattiva manual usa o coletor italiano existente; PISTE restrito às fontes francesas nos caminhos manual e agendado.
- [x] 12 testes de despacho passaram; API Normattiva respondeu HTTP 200 com 7 resultados.
- [ ] Nova coleta pelo painel logado — Supabase externo não permite sessão de teste gerenciada.

## Concluído
- Coletor EUR-Lex (`collect-eu-eurlex`): spec exata do usuário implementada (hash SHA-256 do CELEX, raw_payload com metadados, sem fetch de texto por causa do WAF, rota no scheduler.server.ts, fonte eur-lex.europa.eu criada). Run real: 77 itens novos, 4 duplicados, 0 falhas, títulos em inglês corretos.


## Desvios da spec (restrições do banco)
- `collection_method='sparql'` não existe no enum (apify, http, api, manual, parallel_extract) → usar 'api'.
- `external_id`, `title`, `url`, `doc_type`, `tier`, `trust_tier` não são colunas de raw_items/normalized_items → CELEX e demais campos vão no payload JSONB.

## Frente operacional (2026-09-28)
- [x] Cron EUR-Lex (job 21) disparou sozinho em 28/09 06:00 UTC — HTTP 200.
- [x] Jobs 11 (FR), 17 (IT), 18 (ES), 19 (HR) redirecionados da Edge Function `collect-documents` (timeout de 90s) para as rotas do app.
- [x] Removidos jobs 12 (FR duplicado), 14 (PT), 15 (MT), 16 (CY), 20 (GR) — apontavam para a Edge Function quebrada e não há rota no app.
- [x] Croácia: `marina` sozinho não conta mais (nn-scheduled@1.1.0).
- [x] Nenhum collection_job travado em running/queued.
- [x] Teste real no site publicado: ES, HR, FR (1 novo) e IT (3 novos) — HTTP 200, itens seguem não revisados/internos.
- [x] Alertas de segurança: restam só is_staff/is_staff_owner executáveis por usuários logados — necessário para as regras de acesso; retorna apenas se o próprio usuário é staff. Aceito.

## Pendências antigas
- Itália (Normattiva): texto integral parcial.
- Portugal (DRE): bloqueado por orçamento Apify. Malta/Chipre/Grécia sem rota agendada no app.
- Brasil (DOU): ator ruidoso/caro.

## Triagem EUR-Lex (/items)
- [x] Curadoria em payload.curation (jurisdições, estado de aplicação, nota), auditada por mudança.
- [x] Filtros na URL (EU, estado, fonte, tipo CELEX, aplicação, datas, busca com CELEX exato primeiro).
- [x] Rejeição em lote com motivo; aprovação exige escopo completo (EU).
- [x] metadata.json inclui bloco curation.
- [ ] Teste logado ponta a ponta — o navegador de teste não consegue entrar (Supabase externo); validar manualmente.
- [ ] Itens EUR-Lex não têm texto extraído: o envio ao Exchange pode precisar do texto CELLAR antes.

## Fase 1 (aprovada 2026-09-27)
- [ ] Track A: página /review guiada (fila unreviewed por collected_at, um item por vez, Aprovar→AuraMaris / Aprovar interno / Rejeitar com motivo / Pular, atalhos A/R/S/O, localStorage, contadores por país, /items vira "Advanced Review").
- [ ] Track B: /admin/legacy-audit (Group B por domínio: contagem, verificação de proveniência, normalização, 1 audit_event por lote; raw_items nunca editados).
- [ ] Capy (Fase 2): só placeholder recolhido na Review; sem chamadas LogoriOn até receber prompt ID + categorias AuraMaris.

## Perfis multi-filhotes (2026-09-28)
- [x] Agendamentos semanais já ativos: FR seg 06:00, IT qua 06:30, ES qui 06:00, HR qui 06:30, EU seg 06:00 (UTC).
- [x] Tela /profiles: criar/editar perfis, países e tags permitidos, liberação manual opcional, liberar itens por perfil.
- [x] /keys: trocar o perfil de uma chave ativa.
- [x] Feed aplica países/tags do perfil e, se ligado, só itens liberados; aceita X-API-Key e prefixo oxs_ correto.
- [ ] Capy/IA: aguardando ID do prompt LogoriOn + categorias (decisão do usuário 28/09).

## Validação + enriquecimento (2026-09-28)
- [x] Checagem no ar: fila unreviewed = FR 50, IT 3 (França unificada em FR).
- [x] Botão "Enriquecer 5 com LogoriOn" em /review: grava payload.enrichment (resumo pt-BR, tags, score); não mexe em status/jurisdição; para no primeiro erro. Teste real OK (1 item).
- [ ] Mostrar resumo/score no cartão da revisão.
- [ ] Texto integral EUR-Lex via CELLAR.
- [ ] Novos coletores / perfil comercial (Portos & Cargas, ESG).

## Coletas UK/NL + texto integral UE (2026-09-28)
- [x] UK (legislation.gov.uk) agendado: terças 06:00 UTC
- [x] NL (overheid.nl) agendado: terças 06:30 UTC; texto via repository.overheid.nl (zoek.* dá 403)
- [x] EUR-Lex v1.3: texto integral via CELLAR em novos itens; itens antigos buscam o texto na hora (Capy/resumo)

## GB→UK + Grécia (2026-09-28)
- [x] GB unificado em UK (banco + coletor UK grava "UK")
- [x] Grécia (ΦΕΚ) agendada: quartas 07:00 UTC (rota /api/public/cron/collect-gr-fek) — vale após publicar
- [ ] Primeiro filhote comercial: adiado

## Gibraltar (2026-09-28)
- [x] Código GI separado de UK (nomes + domínios .gi / gibraltarport.com)
- [x] Fontes: Gibraltar Port Authority + Laws of Gibraltar (manual, sem agenda)
- [x] 1ª coleta Port Authority: 4 docs GI, não revisados
- [x] Laws of Gibraltar: coletor próprio por tópicos marítimos (Porto, Autoridade Portuária, Marinha Mercante GI/UK, Águas do Almirantado, Óleo em Águas Territoriais, Agentes Marítimos) — 359 normas catalogadas
- [x] Texto integral: PDF oficial do visualizador (unpdf) + fallback para o texto embutido na página (avisos/nomeações)
- [x] 45 normas de Gibraltar coletadas e normalizadas como GI, todas não revisadas
- [x] Agenda semanal: Laws of Gibraltar quartas 07:30 UTC (/api/public/cron/collect-gi-laws); Port Authority na coleta agendada geral
- [x] Backfill GI concluído: 358 normas marítimas (1 PDF sem texto legível fica de fora)
- [ ] Enriquecer as 362 GI pendentes com LogoriOn (botão em /review, 5 por clique) e triagem humana

## Fila de upload manual (2026-09-30)
- [x] Enum `item_status_type` ganhou `blocked` (URLs que nenhum coletor consegue baixar)
- [x] Tela /admin/manual-queue: lista bloqueados, upload de PDF/HTML/TXT com extração no navegador (unpdf), preview 500 chars, insere novo raw_item que supersede o bloqueado (raw_items nunca editados), normaliza via LogoriOn
- [x] Coletor http-pdf registra `blocked` em 401/403/SSL/timeout/extração vazia em vez de descartar
- [x] Botão "Add to queue" em /sources pré-registra URL bloqueada sem rodar coletor
- [ ] Parser DOCX no upload (hoje pede salvar como PDF)
- [ ] Hooks de `blocked` nos demais coletores por país
- [ ] Bucket de storage para guardar o arquivo original (hoje só o texto vai ao banco)

## Sync de consumidores (2026-09-29)
- [x] Fase 1: feed com order=asc + next_since (keyset por updated_at) para sync incremental seguro
- [x] Fase 2: GET /api/public/feed/stats (total_eligible, last_updated_at) escopado pela chave
- [ ] Fase 3 (adiada): notify_url/notify_secret em consumer_keys + webhook assinado

## Texto integral no feed (30-09-2026)
- [x] Fix 1: feed `include_body=true` (limit ≤ 50) entrega body_text / content_source / text_length do registro coletado; padrão false, sem quebra
- [ ] Reenvio único (touch updated_at) — só após o consumidor publicar suporte a include_body
- [ ] Fix 2: pedido de re-extração sob demanda pelo consumidor
- [ ] Coletor Malta com fallback para fila manual (plano pronto, não construído)

## Seletores de fonte (01-10-2026)
- [x] Listas de fontes mostram "País — Fonte", ordenadas por país e nome
- [x] Correção do lookup de texto integral no feed (RPC fetch_body_text_candidates)
- [ ] Incluir markdown/content/body na RPC (migração futura)

## Coleta resiliente + alerta de falha (2026-10-24)
- [x] Corrigir payload do Parallel Extract ({urls, objective})
- [x] Orquestrador Direto → Parallel → Webshare (via Apify; só se proxy_config setado) → blocked
- [x] E-mail de falha via Resend PRÓPRIO do OryxScrape (nova conexão, não a da Auramaris) → ops@auramaris.app
- [x] Remetente alerts@oryxbara.com verificado; alerta de teste enviado

## Discovery queue (2026-11-02)
- [x] Fase 0: TRUNCATE revogado de anon/authenticated nas 13 tabelas
- [x] Fase 1A: fila de descoberta (4 tabelas) aplicada (20261102070833) — 46/46 testes ok, nada gravado
- [ ] Fase 2 (pendente, antes do builder de chaves): canonicalização de URL conservadora — não assumir http=https, barras repetidas ou barra final sem confirmação; resolver compatibilidade com o CHECK de key_url (hoje exige 'url:https://')
- [ ] Fases 1B/1C, integração LDH, agendamento: não autorizados

## Phase 1A — closed (limitations)
- Authorization tested by simulated DB role/identity, not real browser logins; real-login test deferred to UI phase.
- No DELETE/TRUNCATE verified for anon, authenticated, service_role only — not owner/admin roles.
- Dedup tests proved constraints/uniqueness of supplied keys; key construction, URL canonicalization and conflict handling in code untested until that code exists.
- Exposed schemas NOT verified; schema exposure, grants and RLS are separate layers.
- Pending, separate: conservative URL canonicalization (before Phase 2); 4 old advisor warnings (own round).

## Phase 1B
- [x] Step 1 database structures (migration 20261102081642) — 74/74 rolled-back checks passed.
- [x] Step 2 private bucket document-originals + Storage policies.
- [x] Step 2 closing note: migration 20261103132927; private bucket document-originals, limit 52428800, MIME unrestricted; one staff-only SELECT policy for this bucket; 2 test objects removed, bucket empty; no new advisor warnings. NOT executed: real HTTP login staff/non-staff, direct staff write attempt (DB simulation + service_role signed link do not replace them; absence of write policies is observed config, not a functional test).
- [x] Step 3a code (2026-11-03): direct-PDF originals in pdf-collect, ORIGINALS_STORAGE_MODE off by default, @noble/hashes; 31 new mock-only tests pass. updated_at lease is NOT strict fencing (now() = transaction start).
- [ ] Step 3a real-environment tests + activation (test/on) — needs separate authorization
- [ ] Step 3b Gibraltar / FEK / Malta — not authorized

### Phase 1B step 1 — closing note
- Migration 20261102081642; 74 checks passed; 7 tables empty after tests; privileges of 17 previous tables preserved; no new advisor warnings (4 old unchanged).
- Authorization tested by simulated DB role/identity, not real browser login.
- service_role can still insert an assessment falsely marked human (bypasses RLS, holds INSERT on document_assessments). Protection = server-code discipline + secret service key; do not claim human approval cannot be forged.
- Some tests ran as owner (e.g. append-only); full evaluation of administrative powers NOT done.
- No bucket or collection flow activated in step 1.

### Phase 1B step 2 (authorized 2026-11-03)
- [x] Bucket document-originals (private, 52428800, MIME NULL) + staff SELECT policy (migration 20261103132927); Storage tests passed; test objects removed, bucket 0 objects
- Real staff/non-staff login HTTP test NOT RUN (no session mintable; external Supabase). Staff/non-staff checked by DB simulation only.
- 300 s signed URL + server-only signing are app conventions, not enforced by policy; octet-stream + download are delivery measures, not guarantees.
- [x] Step 3a review fixes (capped read, inline cap D1=A/D2=0/D3, frozen pre-3a compat tests) — 81/81 mock tests pass; not deployed/activated

## Teste real 3a (2026-11-04)
- [x] Caixa "Preserve original PDF — test" (staff + modo test), testes mock.
- [ ] Publicar com storage off — aguarda autorização do dono.
- [ ] Teste real único — aguarda autorização (orçamento Parallel indefinido).

## LDH discovery slice (2026-11-06)
- [x] Manual staff-only LDH search → discovery tables → /discovery list (mock tests).
- [ ] One real acceptance search — waits on owner adding LDH_API_KEY and separate authorization.
- [x] LDH fix: provider_source '/', initial sightings, neutral banner (migration + code + mock tests, no publish)

## Discovery triage (2026-11-07)
- [x] Minimal human triage on /discovery: filters, detail (sightings + outcome history), reject / out of scope / reopen with reason, needs-review flag with note (mock tests, no migration, no publish).
- Limitation: needs_review/review_note keep only current state (no history). reviewed_by/reviewed_at set by app server, not protected by DB trigger. Reopen rules enforced in app only.
- [ ] Browser acceptance as staff — waits on owner (agent has no staff session).

## Approve for collection (2026-11-07)
- [x] Single human approval (lead/identified/source_located -> approved_for_collection) with per-field verification; withdraw -> source_located (mock tests, no migration, no publish).
- Limitation: no approval note or stage history; reviewed_by/at = last review action only; stage rules enforced in app only. Approval never creates a source or job.
- [ ] Browser acceptance as staff + real DB check (RLS, trigger, confidence CHECK, concurrency) — waits on owner.
