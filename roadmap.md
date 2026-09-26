# Roadmap

## Em andamento
- Coletor EUR-Lex (`collect-eu-eurlex`): reescrever conforme spec exata do usuário (hash SHA-256 do CELEX, raw_payload só metadados, sem fetch de texto, rota no scheduler.server.ts, upsert de sources). Limpar o raw_item ruim do primeiro teste e rodar de verdade.

## Desvios da spec (restrições do banco)
- `collection_method='sparql'` não existe no enum (apify, http, api, manual, parallel_extract) → usar 'api'.
- `external_id`, `title`, `url`, `doc_type`, `tier`, `trust_tier` não são colunas de raw_items/normalized_items → CELEX e demais campos vão no payload JSONB.

## Pendências antigas
- Croácia: filtro `marina` (exigir segundo termo náutico) — não aplicado.
- Itália (Normattiva): texto integral parcial.
- Portugal (DRE): bloqueado por orçamento Apify.
- Brasil (DOU): ator ruidoso/caro.
- 1 collection_job "running" travado.
- `collect-documents` (Edge Function externa) sem gatilho/schedule neste projeto.
