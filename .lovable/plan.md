# Coletor EUR-Lex (`collect-eu-eurlex`)

Build exatamente conforme a especificação enviada. Sem modificar coletores existentes, schema ou qualquer outro arquivo.

## Arquivos novos (somente estes)

1. `src/lib/eurlex-collect.server.ts` — implementa `runEurlexCollection(jobId: string): Promise<CollectionResult>`
2. `src/routes/api/public/cron/collect-eu-eurlex.ts` — rota cron protegida por `authenticateCronRequest`

## Especificação

**SPARQL endpoint:** `https://publications.europa.eu/webapi/rdf/sparql`
- Acesso aberto, sem chave, sem header de auth.
- Accept: `application/sparql-results+json`

**Query SPARQL — apenas legislação náutica/marítima (filtros com AND, não OR):**

```sparql
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>

SELECT DISTINCT ?work ?celexNumber ?title ?date ?lang WHERE {
  ?work cdm:work_date_document ?date .
  ?work cdm:resource_legal_id_celex ?celexNumber .

  # CONDIÇÃO 1 (obrigatória): prefixo CELEX legislativo (L = Diretivas, R = Regulamentos)
  FILTER(STRSTARTS(STR(?celexNumber), "3") || REGEX(?celexNumber, "^[LR]"))

  # CONDIÇÃO 2 (obrigatória): ao menos um descritor EuroVoc náutico
  ?work cdm:work_is_about_concept_eurovoc ?concept .
  VALUES ?concept {
    <http://eurovoc.europa.eu/3193>
    <http://eurovoc.europa.eu/4790>
    <http://eurovoc.europa.eu/5551>
    <http://eurovoc.europa.eu/1499>
  }

  # Título em inglês (língua canônica)
  OPTIONAL {
    ?work cdm:work_title ?title .
    FILTER(LANG(?title) = "en")
  }

  # Janela de datas (injetada em runtime)
  FILTER(?date >= "__DATE_FROM__"^^xsd:date)
  FILTER(?date <= "__DATE_TO__"^^xsd:date)
}
ORDER BY DESC(?date)
LIMIT 100
OFFSET __OFFSET__
```

**Os 3 requisitos confirmados:**

1. **`jurisdiction_hint = "EU"`** para todos os itens EUR-Lex (não ISO2 de país). Comentário no código explica que apps consumidores (ex: Auramaris) mapeiam diretivas UE para os países cobertos.
2. **Backfill de primeiro run = 365 dias:** se a fonte não tem itens anteriores, lookback de 365 dias; runs seguintes usam a janela padrão de 7 dias.
3. **Filtro EuroVoc no SPARQL** (acima): evita puxar aviação/transporte terrestre que mencionam "navigation".

**Gravação (padrão dos demais coletores):**
- `collection_jobs`: running → succeeded/failed com contagens.
- `raw_items` imutável, SHA-256 `content_hash` (dedup), `collection_method='api'`.
- `normalized_items`: `publication_status='internal_only'`, `verification_status='unreviewed'`.
- Proveniência: `institution_class='intergovernmental'`, `is_official_domain=true`, `trust_tier='official'`.
- Fonte `sources` (domain `eur-lex.europa.eu`, country `EU`) inserida se não existir.
- Resposta do endpoint: `{ jobId, found, new_items, duplicates, failures }`.

## Verificação

- Teste ao vivo do SPARQL antes de gravar qualquer linha.
- Um run real do endpoint; confirmar itens `unreviewed`/`internal_only`.

## Fora de escopo

Sem mudanças de schema, sem Edge Functions, sem alterar coletores existentes, sem automação além da coleta.
