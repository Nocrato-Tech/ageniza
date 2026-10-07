# Ambiente local

Como sair de um clone recém-feito para um ambiente em que dá para entrar no produto de verdade. Este roteiro foi executado do início ao fim; os comandos são os que funcionaram, não os que deveriam funcionar.

## Pré-requisitos

- **Node.js 22.14+** (a versão exata está em `.nvmrc`) e **pnpm 9.15+**, habilitado por `corepack enable`.
- **Docker** com Compose v2, rodando.
- **ffmpeg** no `PATH`, necessário apenas para os testes de processamento de vídeo do worker.

## Subindo a infraestrutura

```sh
pnpm install
pnpm db:start        # PostgreSQL em 127.0.0.1:54322
pnpm storage:start   # LocalStack (S3 do R2) em 127.0.0.1:9000, cria o bucket
pnpm db:migrate      # aplica todas as migrations
```

`storage:start` gera credenciais locais em `.local/storage.env`, que é ignorado pelo Git. Nenhuma credencial de armazenamento é versionada.

Para o e-mail, suba também o Mailpit:

```sh
docker compose --env-file .local/storage.env up -d --wait mailpit
```

| serviço | endereço |
|---|---|
| API | `127.0.0.1:3001` |
| Web | `127.0.0.1:5173` |
| PostgreSQL | `127.0.0.1:54322` |
| Armazenamento (LocalStack) | `127.0.0.1:9000` |
| Caixa de e-mail (Mailpit) | `127.0.0.1:8025` |

## Criando algo com que trabalhar

**Aqui é onde todo mundo trava.** O banco recém-migrado está vazio: não há agência, não há conta, e **não existe cadastro público** — por decisão de produto, uma agência só nasce por comando interno da operação.

O comando é `cli:agency`, e ele roda o JavaScript compilado. Compile a API antes:

```sh
pnpm --filter @ageniza/api build
```

Depois, com as variáveis do ambiente local:

```sh
MIGRATION_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/ageniza' \
SMTP_URL='smtp://127.0.0.1:1025' \
EMAIL_FROM='Ageniza <no-reply@ageniza.local>' \
APP_PUBLIC_URL='http://127.0.0.1:5173' \
pnpm --filter @ageniza/api cli:agency create --name "Agência Teste" --owner-email "dono@exemplo.test"
```

A saída é o identificador da agência e a validade do convite:

```json
{"agencyId":"741c4d6d-…","expiresAt":"2026-10-01T23:24:21.392Z"}
```

Os outros comandos do CLI:

```sh
pnpm --filter @ageniza/api cli:agency suspend --agency-id <uuid>
pnpm --filter @ageniza/api cli:agency reactivate --agency-id <uuid>
pnpm --filter @ageniza/api cli:agency resend-activation --agency-id <uuid>
```

## Aprovando uma troca de e-mail

A pessoa não troca o próprio e-mail: ela pede pelo menu de conta, e a operação aprova pelo CLI, com as mesmas quatro variáveis do `cli:agency`. Os pedidos não geram notificação; `list` é como se descobre o que está aberto.

```sh
pnpm --filter @ageniza/api cli:email-change list
pnpm --filter @ageniza/api cli:email-change approve --request-id <uuid>
pnpm --filter @ageniza/api cli:email-change approve --request-id <uuid> --ownership-confirmed
pnpm --filter @ageniza/api cli:email-change reject --request-id <uuid>
```

`approve` envia o link de confirmação ao e-mail **novo** (no Mailpit, localmente) e imprime só o id do pedido e a validade; nunca o token. Conta que é Owner de uma agência só é aprovada com `--ownership-confirmed`, depois de a operação confirmar a titularidade fora do produto. Aprovar de novo um pedido já aprovado e não usado emite um link novo, e o anterior deixa de valer.

## Dados de demonstração

Para pular a criação manual e já ter um cenário realista no banco local:

```sh
pnpm seed:demo --i-know-this-is-local
```

O comando **se recusa a rodar fora do ambiente local**: exige a flag `--i-know-this-is-local`, recusa `NODE_ENV` ou `APP_ENV` igual a `production` (sem diferenciar maiúsculas ou espaços), recusa banco que não seja loopback — nas duas conexões (`DATABASE_URL` e `MIGRATION_DATABASE_URL`), conferindo o host que o driver realmente usaria (um `?host=` ou caminho de socket é recusado) — e recusa quando as duas URLs apontam para bancos diferentes. Nada é escrito (nem uma senha é trocada) antes de o portão inteiro passar.

O que ele cria, sempre no banco local:

- a agência **Agência Horizonte**, com o Owner e uma pessoa para cada preset (Admin, Gestor de conta, Produção, Vendas, Financeiro), com nome e cargo plausíveis;
- 6 clientes com cadastro e estudo de marca em graus variados, personas e conversas — algumas aguardando a agência;
- uma pessoa de portal na Padaria Central;
- 2 convites de colaborador pendentes;
- a agência **Estúdio Ponte**, pequena, para demonstrar o isolamento entre agências.

Rodar de novo **não duplica nem falha**: os identificadores derivam de chaves estáveis e cada escrita é um upsert ou um insert guardado. As contas são criadas como a rota de conta nova as cria (com o aceite de Termos e Privacidade gravado nas versões configuradas), e os vínculos e convites passam por `app_private.accept_invitation` e pela RLS do papel `ageniza_app`, nunca por inserts que contornem regra. Até o cargo (`job_title`) é gravado pelo caminho da aplicação.

No fim o comando imprime o e-mail, a senha e a URL de entrada de cada perfil. **As senhas são geradas a cada execução e existem só nessa saída**; rodar de novo troca todas e encerra as sessões antigas dessas contas, e a saída mais recente é a que vale. `pnpm db:reset` apaga tudo.

A suíte de integração que usa este comando (`seed-demo.integration.test.ts`) roda com um namespace e um domínio de e-mail próprios e limpa só o que criou: rodar `pnpm --filter @ageniza/api test:integration` depois do seed **não** apaga o cenário de demonstração.

> Arquivar um cliente e agendar encerramento ainda ficam de fora: dependem das funções da #123, e o seed não escreve colunas que a aplicação não pode escrever.

## Pegando o link de ativação

O convite **não aparece em lugar nenhum além do e-mail**. O banco guarda apenas o hash do token: nem a operação recupera o token depois de enviado — é decisão de segurança, não limitação.

Abra o Mailpit em <http://127.0.0.1:8025> e clique na mensagem "Ative sua agência no Ageniza". O link tem esta forma:

```
http://127.0.0.1:5173/invite/vghP5a3k08wKF9rwyqJZE71uvx218k7mUj7Bwcs_pio
```

Pela linha de comando, se preferir:

```sh
curl -s http://127.0.0.1:8025/api/v1/messages
curl -s http://127.0.0.1:8025/api/v1/message/<ID>
```

> **Atenção:** a interface ainda não existe. Abrir esse link no navegador hoje não leva a lugar nenhum — as telas estão especificadas em [`specs/auth.md`](../specs/auth.md) e recortadas no épico #62. Até lá, o aceite é exercitável apenas pela API, com `GET /invitations/:token` e `POST /invitations/:token/accept-new-account`.

## Rodando a aplicação

```sh
pnpm dev
```

Sobe API, web e worker em modo de desenvolvimento, na máquina. A alternativa é rodar tudo em contêiner:

```sh
pnpm docker:up     # sobe banco, migra, constrói as imagens e espera a saúde
pnpm docker:logs
pnpm docker:down   # preserva o volume do banco
```

`pnpm db:reset` recria o banco do zero a partir das migrations, e **apaga os dados locais** — inclusive a agência que você acabou de criar.

## Disparando o job diário de arquivamento

O worker registra sozinho o `clients.archive-due` quando sobe (`pnpm dev` ou `pnpm docker:up`): ele arquiva os clientes cujo `closing_date` já passou, e é só isso que ele faz. Roda uma vez cada vez que o worker sobe e depois de hora em hora (aos 10 minutos, em `America/Sao_Paulo`, o que inclui as 00:10), então basta subir o worker de novo para ele rodar. Para testar sem esperar a virada do dia, com o worker no ar:

1. **Deixe um cliente vencido.** A rota recusa data de ontem de propósito, então localmente isso é uma linha de SQL como dono do banco (troque o `<uuid>` pelo id do cliente):

   ```sh
   docker exec ageniza-local-postgres-1 psql -U postgres -d ageniza -c "update public.clients set closing_date = (now() at time zone 'America/Sao_Paulo')::date - 1 where id = '<uuid>' and status = 'active'"
   ```

2. **Dispare o job**, inserindo-o na fila como o agendamento faria:

   ```sh
   docker exec ageniza-local-postgres-1 psql -U postgres -d ageniza -c "insert into pgboss.job (name, data, retry_limit, retry_delay, retry_backoff, dead_letter) values ('clients.archive-due', '{}', 3, 10, true, 'clients.archive-due.dead')"
   ```

   Em poucos segundos o log do worker traz `Archived the clients whose contract ended` com `archived` (a quantidade, sem nome de cliente nem de pessoa) e `Durable job completed`. O cliente fica `archived`, com os convites de portal pendentes revogados e o portal respondendo 404; um evento `client.archived` com `request_id = 'job:clients.archive-due'` aparece em `audit.events`.

3. **Confira o agendamento** (uma linha só, mesmo depois de reiniciar o worker):

   ```sh
   docker exec ageniza-local-postgres-1 psql -U postgres -d ageniza -c "select name, cron, timezone from pgboss.schedule"
   ```

Sem worker, `select app_private.archive_due_clients();` faz a mesma coisa e devolve a quantidade: o job é só o relógio. Rodar duas vezes seguidas arquiva zero na segunda. Uma virada em que o worker estava parado é reposta quando ele sobe de novo, porque o job roda na inicialização.

## Rodando os testes

Nem todo teste é igual, e os que dependem de infraestrutura falham de forma confusa quando ela não está no ar.

| comando | o que cobre | exige |
|---|---|---|
| `pnpm test` | unitários de todos os workspaces | nada |
| `pnpm lint` · `pnpm typecheck` · `pnpm build` | os mesmos portões do CI | nada |
| `pnpm db:test:local` | integração do banco e isolamento por RLS | PostgreSQL no ar |
| `pnpm --filter @ageniza/api test:integration` | auth, convites, contextos e mídia contra o banco real | PostgreSQL **e** armazenamento |
| `pnpm --filter @ageniza/worker test:integration` | fila durável e processamento de vídeo | PostgreSQL, armazenamento e **ffmpeg** |

Antes de abrir um PR, rode o conjunto inteiro. O CI roda exatamente isso.

## Quando algo não sobe

- **`pnpm storage:start` falha e o contêiner nunca fica saudável** — o script despeja o log do contêiner antes de propagar o erro. A causa costuma estar ali, não no script.
- **Testes de integração com `ECONNREFUSED 127.0.0.1:54322`** — o PostgreSQL não está no ar. `pnpm db:start`.
- **Consulta volta vazia sem erro** — quase sempre é contexto de usuário ausente na transação, e a RLS está fazendo o trabalho dela. Não é bug de SQL. Ver o [ADR 0011](adr/0011-self-hosted-postgres-and-better-auth.md).
- **`cli:agency` reclama de configuração** — as quatro variáveis do comando acima são obrigatórias. O comando é a ferramenta de operação e aceita o banco que a operação indicar, inclusive o serviço `postgres` da rede interna no VPS; quem exige loopback é o `seed:demo`, que é só de desenvolvimento.
