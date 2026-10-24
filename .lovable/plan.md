# Plano: coleta resiliente com fallback automático e alerta por e-mail

## Objetivo
Quando um site oficial (.gr, .mt, .it ou qualquer outro) bloquear a coleta, o sistema tenta sozinho caminhos alternativos. Se todos falharem, a página vai para a fila manual e um e-mail é enviado para ops@auramaris.app.

## Fluxo de coleta (por URL)

```text
1. Fetch direto (HTTP)
      | 401/403/407/429, desafio Cloudflare, timeout, SSL, página vazia (SPA)
      v
2. Parallel Extract (corrigido: payload só {urls, objective})
      | erro, 422, resultado vazio
      v
3. Fetch direto via proxy residencial Webshare do país da fonte
   (usa proxy_config da fonte; se ausente, deduz o país pelo domínio .gr/.mt/.it)
      | falha
      v
4. Registro "blocked" na Manual Upload Queue (comportamento atual)
   + e-mail de falha para ops@auramaris.app
```

- 404 continua sem retry (página não existe, não é bloqueio).
- Cada tentativa fica registrada no item: `extraction_method` = `direct` | `parallel_extract` | `webshare_proxy`, e uma lista `attempts` com método, status e motivo (sem credenciais).
- O Webshare entra como 3ª camada porque é ele que dá IP local (grego, maltês, italiano) — resolve bloqueio geográfico que o Parallel às vezes não resolve. Fontes Apify continuam usando o proxy Webshare dentro do crawler, como hoje.
- A hierarquia de Malta (HTTP → Parallel → Apify → blocked) não muda; só passa a disparar o mesmo alerta no final.

## E-mail de falha (ops@auramaris.app)
Conteúdo:
- Site e URL afetados, nome e país da fonte
- Data e hora (UTC e horário de Lisboa)
- Motivo final e o resultado de cada tentativa (Direto / Parallel / Webshare)
- ID do job de coleta e do item bloqueado, com link para a Manual Upload Queue
- Se foi coleta manual ou agendada

Regras anti-spam:
- No máximo 1 e-mail por URL bloqueada (mesma chave nunca envia duas vezes).
- Se um job tiver várias URLs falhando, envia um único e-mail resumo do job.
- Falha no envio do e-mail nunca derruba a coleta (só registra no log).

## Pré-requisito: domínio de envio
O projeto ainda não tem domínio de e-mail configurado. Precisaremos configurar um remetente do auramaris.app (ex.: notify.auramaris.app) — vou abrir a tela de configuração ao iniciar. Os e-mails passam a sair assim que o DNS for verificado. (Alternativa: Resend, se preferir manter o padrão das outras frentes da Auramaris.)

## Escopo e limites
- Sem migrations, sem Edge Functions, sem alterar o schema.
- Nenhuma credencial (Parallel, Webshare) em código, logs ou e-mails.
- Revisão humana continua obrigatória: o fallback só coleta; nada é aprovado ou publicado automaticamente.

## Detalhes técnicos
- `parallel-fetch.server.ts`: body do extract reduzido a `{ urls, objective }`; ler `full_content`/`excerpts` da resposta; idem revisar `/v1/search` (`objective` + `search_queries`, `mode: "fast"`).
- Novo `src/lib/fetch-fallback.server.ts`: orquestra Direto → Parallel → Webshare, retorna texto + `attempts[]`. Webshare via `getWebshareProxy` existente; fetch com proxy no Worker exige um caminho compatível (verificar suporte; se o runtime não aceitar proxy HTTP no fetch, a 3ª camada usa Apify com `proxyUrls` para aquela URL).
- `pdf-collect.server.ts` e `malta-collect.server.ts` passam a usar o orquestrador; `recordBlockedItem` recebe `attempts` e chama o alerta.
- Novo `src/lib/ops-alerts.server.ts` + template de e-mail `collection-failure` (app email gerenciado do Lovable), destinatário fixo ops@auramaris.app, `idempotencyKey = blocked-<raw_item_id>`.
- Testes vitest: classificação de erros (403 cai para Parallel, 404 não), ordem das camadas, e-mail enviado só quando as três falham.
- Validação: coleta manual na e-nomothesia.gr, transport.gov.mt e fonte .it, conferindo `extraction_method` nos raw_items.
