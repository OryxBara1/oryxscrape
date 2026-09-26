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

## Triagem EUR-Lex (/items)
- [x] Curadoria em payload.curation (jurisdições, estado de aplicação, nota), auditada por mudança.
- [x] Filtros na URL (EU, estado, fonte, tipo CELEX, aplicação, datas, busca com CELEX exato primeiro).
- [x] Rejeição em lote com motivo; aprovação exige escopo completo (EU).
- [x] metadata.json inclui bloco curation.
- [ ] Teste logado ponta a ponta — o navegador de teste não consegue entrar (Supabase externo); validar manualmente.
- [ ] Itens EUR-Lex não têm texto extraído: o envio ao Exchange pode precisar do texto CELLAR antes.
