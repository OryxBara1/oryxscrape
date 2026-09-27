# Corrigir o agendamento diário do coletor EUR-Lex

## Contexto

O job `collect-eu-eurlex` (jobid 13) no pg_cron aponta para uma URL de Edge Function do Supabase que não existe. O coletor real vive no app Lovable em `POST /api/public/cron/collect-eu-eurlex`, protegido por `Authorization: Bearer <LOVABLE_CRON_SECRET>`.

## Sobre o segredo (ponto importante)

O valor de `LOVABLE_CRON_SECRET` **não pode ser lido pelo sandbox sem expô-lo** — qualquer `echo $LOVABLE_CRON_SECRET` ou `printenv` apareceria nos logs da sessão. O caminho seguro:

1. Você abre **Project Settings → Secrets** no Lovable e copia o valor de `LOVABLE_CRON_SECRET`.
2. Você mesmo cola o valor no comando SQL (no Supabase SQL Editor) ou na configuração do agendador externo.

Eu nunca vejo nem manipulo o valor.

## URLs do app

- Publicado (produção): `https://oryxscrape.lovable.app`
- Estável (imutável, serve a versão publicada): `https://project--df887a9c-40f0-4e83-a2cb-f9d4da5e1efb.lovable.app`
- Preview: `https://id-preview--df887a9c-40f0-4e83-a2cb-f9d4da5e1efb.lovable.app` (não usar para cron — muda a cada build)

Endpoint completo: `https://oryxscrape.lovable.app/api/public/cron/collect-eu-eurlex`

**Pré-requisito:** a rota cron precisa estar na versão publicada. Se o app foi publicado antes da criação da rota, é preciso clicar em Publish/Update antes de ativar o agendamento.

## Opção A (recomendada) — Agendador externo

Usar um agendador externo (cron-job.org, EasyCron, GitHub Actions scheduled workflow etc.):

- Método: `POST`
- URL: `https://oryxscrape.lovable.app/api/public/cron/collect-eu-eurlex`
- Header: `Authorization: Bearer <valor copiado de LOVABLE_CRON_SECRET>`
- Frequência: diária (ex.: 06:00 UTC)
- Depois: remover o job quebrado do pg_cron (você roda no SQL Editor: `SELECT cron.unschedule(13);`)

Vantagem: nenhum SQL com segredo fica gravado no banco, e a rota já existe e foi testada.

## Opção B — Corrigir o pg_cron (você executa o SQL)

Se preferir manter o agendamento dentro do Supabase, você roda no SQL Editor (colando o segredo que copiou):

```sql
SELECT cron.unschedule(13);

SELECT cron.schedule(
  'collect-eu-eurlex',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://oryxscrape.lovable.app/api/public/cron/collect-eu-eurlex',
    headers := jsonb_build_object(
      'Authorization', 'Bearer COLE_AQUI_O_LOVABLE_CRON_SECRET',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Observação: o segredo ficará visível na definição do job no banco (qualquer admin do Supabase pode lê-lo). Por isso a Opção A é preferível.

## Verificação (após você configurar)

1. Eu chamo a rota publicada uma vez com `invoke-server-function` para confirmar que responde 200 em produção.
2. No dia seguinte, confiro em `collection_jobs` se apareceu um job novo com `source` EUR-Lex criado pelo agendamento.

## Fora de escopo

- Nenhuma alteração de código, schema ou coletor.
- Não leio nem exibo o valor de `LOVABLE_CRON_SECRET` em nenhum momento.
