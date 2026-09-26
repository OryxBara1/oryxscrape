# Roadmap

## Concluído
- Coletor EUR-Lex (`collect-eu-eurlex`): spec exata do usuário implementada (hash SHA-256 do CELEX, raw_payload com metadados, sem fetch de texto por causa do WAF, rota no scheduler.server.ts, fonte eur-lex.europa.eu criada). Run real: 77 itens novos, 4 duplicados, 0 falhas, títulos em inglês corretos.


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
