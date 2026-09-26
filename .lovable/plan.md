# Coletor EUR-Lex (`collect-eu-eurlex`)

Coletor de legislação marítima da União Europeia via CELLAR SPARQL (endpoint público, sem chave, sem custo), seguindo o mesmo padrão dos coletores por país (França, Espanha, UK, etc.).

## Arquivos novos

1. `src/lib/eurlex-collect.server.ts` — lógica do coletor (`runEurlexCollection`)
2. `src/routes/api/public/cron/collect-eu-eurlex.ts` — rota cron protegida por `authenticateCronRequest`

## Comportamento

- **Fonte:** CELLAR SPARQL endpoint (`https://publications.europa.eu/webapi/rdf/sparql`), aberto, sem autenticação.
- **Filtro EuroVoc no SPARQL (ajuste 3):** a query filtra documentos tagueados com os descritores EuroVoc náuticos — `waterway transport` (eurovoc/3193), `pleasure craft` (eurovoc/4790), `maritime safety` (eurovoc/5551), `sea transport` (eurovoc/1499) — e/ou CELEX prefix `L` (legislação). Isso evita puxar aviação/transporte terrestre que mencionam "navigation".
- **Janela de datas (ajuste 2):** primeiro run (fonte sem itens anteriores) usa lookback de **365 dias** para capturar diretivas em vigor; runs seguintes usam a janela padrão de 7 dias.
- **Teto de segurança:** 5 páginas / 100 documentos por run.
- **`jurisdiction_hint = "EU"` (ajuste 1):** todos os itens EUR-Lex gravam `EU`, não um ISO2 de país. Comentário no código explica que apps consumidores (ex: Auramaris) são responsáveis por mapear diretivas UE para os países cobertos.
- **Gravação:** `collection_jobs` (running → succeeded/failed), `raw_items` imutável com SHA-256 `content_hash` (dedup), depois `normalized_items` com `publication_status='internal_only'`, `verification_status='unreviewed'`, `collection_method='api'`.
- **Proveniência:** `institution_class='intergovernmental'`, `is_official_domain=true`, `trust_tier='official'`.
- **Fonte:** insere linha em `sources` (domain `eur-lex.europa.eu`, country `EU`, collection_method `api`, schedule_notes apontando a rota cron) se não existir.
- **Scheduler:** `src/lib/scheduler.server.ts` roteia domain `eur-lex.europa.eu` → `runEurlexCollection`.
- **Resposta do endpoint:** `{ jobId, found, new_items, duplicates, failures }`.

## Verificação

- Teste ao vivo do SPARQL antes de gravar qualquer linha no banco.
- Um run real do endpoint; confirmar que itens ficam `unreviewed`/`internal_only`.

## Fora de escopo

Sem mudanças de schema, sem Edge Functions, sem alterar coletores existentes, sem automação além da coleta.
