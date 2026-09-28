# Roadmap

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
