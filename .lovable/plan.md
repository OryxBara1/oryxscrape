# Triagem de itens EUR-Lex na tela "Collected items"

Objetivo: reduzir o tempo para uma decisão confiável por item. Nada de novos coletores; nenhuma cópia por país.

## Decisões fechadas
- O coletor continua gravando `jurisdiction_hint = 'EU'` e nunca infere países.
- O revisor preenche manualmente as jurisdições afetadas e o estado de aplicação.
- Um único pacote EU vai ao Drive, com essas informações no `metadata.json`.
- "Enviado ao Exchange" não significa "pronto para a Marin@"; extração de texto é etapa posterior.
- Os 77 itens já coletados ficam intactos até uma decisão humana.

## Estados (sem criar novos valores no banco)
Os estados existentes são combinados e mostrados na tela com rótulos claros:

| Rótulo na tela | Como é guardado |
|---|---|
| Descoberto | `unreviewed` + `internal_only` |
| Rejeitado / irrelevante | `rejected` + `internal_only` |
| Revisado (escopo definido) | `reviewed` + `internal_only` + curadoria preenchida |
| Aprovado para Exchange | `reviewed` + `eligible` |
| Enviado (01_Pending_Review) | handoff `pending` |
| Arquivado | handoff `archived` |

Rejeitar não pede jurisdição. Aprovar para Exchange exige jurisdições + estado de aplicação.

## Curadoria por item (3 decisões)
1. Relevância: relevante / irrelevante (irrelevante = rejeitar com motivo).
2. Escopo: `directly_applicable`, `requires_transposition`, `implementation_to_verify`, `not_applicable`.
3. Destino: jurisdições afetadas (caixas ES, FR, IT, HR, PT, GR, MT, CY, NL, DE; nenhuma marcada por padrão) + nota editorial.

Guardado como bloco `curation` (jurisdições, estado de aplicação, nota, revisor, data) e cada mudança registra um evento de auditoria com valores antigo/novo.

## Filtros na tela
- Jurisdição com opção "EU" visível.
- Estado (rótulos acima), fonte/domínio, tipo de ato (Diretiva / Regulamento / Decisão, derivado do CELEX: L, R, D).
- Estado de aplicação, período de data do documento.
- Busca livre por CELEX, título e tag.
- Filtros refletidos na URL para poder voltar à mesma lista.

## Detalhe do item
CELEX, título, tipo, data, descritores EuroVoc, URL canônica (botão "Abrir fonte oficial" em nova aba), payload, e o formulário de curadoria com as ações: Rejeitar, Salvar escopo, Aprovar para Exchange, Marcar "precisa de implementação nacional".

## Revisão em lote (segura)
- Seleção múltipla só para Rejeitar (com motivo único) — nunca aprovação em lote.
- Confirmação mostrando quantos itens mudam; um evento de auditoria por item.

## Exchange
- `metadata.json` do pacote EU passa a incluir `applies_to_jurisdictions`, `application_status`, `celex`, `doc_type`, `date_document`, `reviewer_note`.
- País do pacote continua `EU`; nenhum pacote por país.
- Edição de jurisdições depois do envio segue a regra atual: só enquanto `pending`, reescrevendo apenas o `metadata.json`.

## Critérios de aceitação / teste manual
1. Filtrar EU + Descoberto mostra os 77 itens EUR-Lex.
2. Busca por um CELEX encontra o item exato.
3. Rejeitar um item: some do filtro "Descoberto", auditoria registrada, nenhum país pedido.
4. Aprovar sem jurisdição é bloqueado; com jurisdição e estado vira "Aprovado para Exchange".
5. Enviar ao Exchange gera um único pacote EU com as jurisdições no `metadata.json` no Drive.
6. Rejeição em lote de 3 itens gera 3 eventos de auditoria.
7. Outras fontes nacionais continuam funcionando como hoje.

## Detalhes técnicos
- Primeiro passo: verificar se `normalized_items.payload` pode ser atualizado (sem trigger de imutabilidade). Se puder, `curation` fica em `payload.curation` — zero mudança de schema. Se não puder, uma migração mínima adiciona uma coluna `curation jsonb` com as mesmas regras de acesso staff (ponto a confirmar antes de construir).
- A listagem hoje usa a função `get_staff_item_tier_matrix` (limite 200). Novos filtros por texto/CELEX/tipo/aplicação serão aplicados numa nova função de servidor autenticada sobre `normalized_items` + `sources`, mantendo a tabela atual.
- Validação no servidor: aprovação exige `applies_to_jurisdictions` não vazio e `application_status` válido; apenas staff.
- Arquivos afetados: tela de itens, `items.functions.ts`, montagem de metadados em `exchange.server.ts`.
