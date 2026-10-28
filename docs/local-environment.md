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

**Aqui é onde todo mundo trava.** O banco recém-migrado está vazio: não há agência nem conta. Uma agência só nasce pelo produto: uma conta com e-mail verificado usa "Criar agência" e a agência nasce em teste de 14 dias (decisão 2026-10-27, "a agência só nasce pelo produto"). Não existe comando que crie agência.

O caminho mais curto é a semente de demonstração (seção [Dados de demonstração](#dados-de-demonstração)): ela cria duas agências com plano `isenta`, sem limites. Para ver o teste por dentro, entre com uma conta de e-mail verificado e use "Criar agência" no seletor de contexto ou em `/contextos`.

O plano de uma agência que já existe é trocado pela operação com `cli:agency`, que roda o JavaScript compilado. Compile a API antes:

```sh
pnpm --filter @ageniza/api build
```

Depois, com as variáveis do ambiente local:

```sh
MIGRATION_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/ageniza' \
SMTP_URL='smtp://127.0.0.1:1025' \
EMAIL_FROM='Ageniza <no-reply@ageniza.local>' \
APP_PUBLIC_URL='http://127.0.0.1:5173' \
pnpm --filter @ageniza/api cli:agency set-plan --agency-id <uuid> --plan ativo
```

Os comandos do CLI:

```sh
pnpm --filter @ageniza/api cli:agency set-plan --agency-id <uuid> --plan isenta|ativo|trial [--ends-at 2026-12-31]
pnpm --filter @ageniza/api cli:agency set-email-limit --agency-id <uuid> --per-day 50|padrao
pnpm --filter @ageniza/api cli:agency suspend --agency-id <uuid>
pnpm --filter @ageniza/api cli:agency reactivate --agency-id <uuid>
pnpm --filter @ageniza/api cli:agency resend-activation --agency-id <uuid>
```

`set-plan` é a única troca de plano, e a aplicação nunca muda `plan`: `isenta` é a agência que não paga e usa tudo; `ativo` é a que fez upgrade; `trial` devolve um teste com outra data de fim (`--ends-at`, obrigatório; só a data termina às 23:59:59 de Brasília). Cada troca fica auditada. `set-email-limit` muda o limite diário de convites enviados pela agência (20 no teste e 200 nos outros planos; `padrao` volta ao do plano). Para testar o somente leitura na máquina, mude a data pelo banco: `update public.agencies set trial_ends_at = now() - interval '1 minute' where id = '<uuid>'`.

O aviso de teste vencido mostra um contato só quando a API tem `SUPPORT_CONTACT_EMAIL` (um e-mail público, sem segredo). Sem ela, o aviso só diz que o teste acabou e que os dados estão guardados.

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
- **dados de Conteúdo** (issue #608), nos clientes Padaria Central, Clínica Viver Bem e Café do Alto: 11 conteúdos, um em cada estado (em produção, aguardando aprovação, em ajuste, aprovado, publicado e cancelado), com três atrasados e quatro com prazo em dois dias, calculados a partir do dia de hoje em São Paulo; subtarefas pendente, entregue e aprovada; três roteiros de stories (um enviado para hoje, que aparece no Início do portal, um gravado de ontem e um rascunho de amanhã); duas conversas de conteúdo; uma pasta própria com a de trabalho dentro dela; e 11 mídias. Tudo passa pelas funções que as rotas chamam, com a pessoa que a regra manda (o Admin planeja e publica, a pessoa do portal aprova e pede ajuste, Produção entrega). **As mídias são linhas sem arquivo no armazenamento**: a semente não sobe objeto, então um cartão ou o post do portal não desenha imagem e a URL assinada de uma mídia dá 404 ao abrir;
- 2 convites de colaborador pendentes;
- a agência **Estúdio Ponte**, pequena, para demonstrar o isolamento entre agências.

Rodar de novo **não duplica nem falha**: os identificadores derivam de chaves estáveis e cada escrita é um upsert ou um insert guardado. As contas são criadas como a rota de conta nova as cria (com o aceite de Termos e Privacidade gravado nas versões configuradas), e os vínculos e convites passam por `app_private.accept_invitation` e pela RLS do papel `ageniza_app`, nunca por inserts que contornem regra. Até o cargo (`job_title`) é gravado pelo caminho da aplicação.

No fim o comando imprime o e-mail, a senha e a URL de entrada de cada perfil. **As senhas são geradas a cada execução e existem só nessa saída**; rodar de novo troca todas e encerra as sessões antigas dessas contas, e a saída mais recente é a que vale. `pnpm db:reset` apaga tudo.

A suíte de integração que usa este comando (`seed-demo.integration.test.ts`) roda com um namespace e um domínio de e-mail próprios e limpa só o que criou: rodar `pnpm --filter @ageniza/api test:integration` depois do seed **não** apaga o cenário de demonstração.

> Arquivar um cliente e agendar encerramento ainda ficam de fora: dependem das funções da #123, e o seed não escreve colunas que a aplicação não pode escrever.

## Pegando o link de ativação

Só uma agência que já existia com a ativação pendente tem esse convite, reenviado por `cli:agency resend-activation`; nenhuma agência nova nasce assim. Os convites de colaborador e de portal chegam ao Mailpit do mesmo jeito.

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

Sobe API, web e worker em modo de desenvolvimento, na máquina. Antes de subir, o turbo compila os pacotes internos (`packages/*`) de que cada app depende, então um clone com `dist` antigo ou ausente sobe sem passo manual. Durante o `dev`, o Vite lê o `@ageniza/ui` direto da fonte (`packages/ui/src`): uma edição ali aparece no web na hora. Os outros pacotes (`contracts`, `config`, `core`, `database`, `email`) seguem compilados: depois de editar um deles, reinicie o `pnpm dev`, que recompila o pacote antes de subir. Por isso, um erro de tipo em qualquer pacote interno impede o `pnpm dev` inteiro de subir, e não só o app que usa o pacote. O build de produção e os testes continuam usando o pacote compilado.

As portas e o banco vêm do `.env`, porque o turbo não repassa variáveis do shell para as tarefas. `PORT=3100 pnpm dev` não muda nada: vale o `.env`. Para subir ao lado de outra instância, mude no `.env` `PORT`, `WORKER_HEALTH_PORT`, `API_CORS_ORIGINS`, `VITE_API_BASE_URL`, `APP_PUBLIC_URL` (senão os links de e-mail e de convite levam à instância do outro) e as URLs do banco, e passe a porta do Vite: `pnpm dev -- --port 5273 --host 127.0.0.1 --strictPort`. Os argumentos depois de `--` vão para todos os apps, mas só o Vite os lê.

### O endereço público da API

O cookie do link de aprovação (`ageniza_approval`) só volta para o caminho em que o **navegador** vê a API, e o cliente HTTP do web monta toda requisição a partir de `VITE_API_BASE_URL`, caminho incluso. Por isso o `.env` tem `API_PUBLIC_URL`, que tem de ser o mesmo endereço que `VITE_API_BASE_URL`: localmente a API tem a própria origem (`API_PUBLIC_URL=http://127.0.0.1:3001`, cookie em `/portal-approval`); em produção o contêiner web repassa `/api`, e vale o padrão, `APP_PUBLIC_URL` + `/api` (cookie em `/api/portal-approval`). Um `.env` antigo sem a variável cai no padrão de produção: o link de aprovação até abre, mas o cookie não volta e a troca do token parece não funcionar. Acrescente a linha do `.env.example`.

### Entrar com o Google

O Google fica **desligado** enquanto `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` estiverem vazios no `.env`: `GET /auth/providers` responde `{ "google": false }`, as rotas do Google respondem 404 e as telas não mostram o botão. Para ligar, crie no Google Cloud Console um cliente OAuth do tipo "Aplicativo da Web", autorize nele a URL de retorno abaixo e preencha as duas variáveis (as duas juntas: só uma recusa a subida da API). O segredo é só do servidor; nunca ponha `VITE_` nelas.

Em desenvolvimento a API tem a própria origem (`VITE_API_BASE_URL=http://127.0.0.1:3001`), então a URL de retorno é a da API, e o `.env` a informa em `GOOGLE_CALLBACK_URL=http://127.0.0.1:3001/auth/callback/google`. Sem essa variável vale `APP_PUBLIC_URL` + `/api/auth/callback/google`, que é o caminho em produção, onde o contêiner web repassa `/api` à API. Os testes de integração não falam com o Google: simulam o endpoint de token e as chaves do id token (`apps/api/src/modules/auth/test-support/fake-google.ts`).

A alternativa é rodar tudo em contêiner:

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

Sem worker, `select app_private.archive_due_clients();` faz a mesma coisa e devolve a quantidade (o job chama `due_client_ids()` e `archive_due_client(cliente)` um cliente por vez, e a função de lote é feita das duas): o job é só o relógio. Rodar duas vezes seguidas arquiva zero na segunda. Uma virada em que o worker estava parado é reposta quando ele sobe de novo, porque o job roda na inicialização.

## Vendo o e-mail ao cliente

O worker pergunta à fila de notificação a cada minuto (e uma vez ao subir) e envia ao cliente "conteúdos para aprovar" e "publicado", pelo Mailpit (<http://127.0.0.1:8025>), com o link `APP_PUBLIC_URL/portal/<cliente>/calendario`. Ele só se registra com `SMTP_URL`, `EMAIL_FROM` e `APP_PUBLIC_URL` no ambiente (o `.env.example` e o `compose.yml` já os trazem); sem eles o worker avisa no log e segue sem enviar. Para ver um e-mail sem esperar os 15 minutos, depois de enviar um conteúdo para aprovação na agência, adiante o item como dono do banco (troque o `<uuid>` pelo id do conteúdo):

```sh
docker exec ageniza-local-postgres-1 psql -U postgres -d ageniza -c "update public.notification_queue set send_after = created_at where content_id = '<uuid>' and sent_at is null and discarded_at is null"
```

No minuto seguinte o Mailpit recebe **um** e-mail por pessoa do portal. O log do worker traz só contagens (`E-mails to the clients processed`) e, numa falha do provedor, um código `smtp_*`: nunca endereço, nome ou link.

## Rodando os testes

Nem todo teste é igual, e os que dependem de infraestrutura falham de forma confusa quando ela não está no ar.

| comando | o que cobre | exige |
|---|---|---|
| `pnpm test` | unitários de todos os workspaces | nada |
| `pnpm lint` · `pnpm typecheck` · `pnpm build` | os mesmos portões do CI | nada |
| `pnpm db:test:local` | integração do banco e isolamento por RLS | PostgreSQL no ar e [banco próprio](#banco-dos-testes-de-integração) |
| `pnpm --filter @ageniza/api test:integration` | auth, convites, contextos e mídia contra o banco real | PostgreSQL **e** armazenamento |
| `pnpm --filter @ageniza/worker test:integration` | fila durável e processamento de vídeo | PostgreSQL, armazenamento e **ffmpeg** |

Antes de abrir um PR, rode o conjunto inteiro. O CI roda exatamente isso.

### Banco dos testes de integração

As três suítes de integração (`db:test:local`, a da API e a do worker) **exigem** `DATABASE_URL` (papel `ageniza_app`) e `MIGRATION_DATABASE_URL` (dono) apontando para um banco **seu**. Não há valor padrão: se uma das duas faltar, a suíte recusa e diz qual, e se qualquer uma apontar para o banco chamado exatamente `ageniza` (o do ambiente local do dono, onde ficam os dados de demonstração) ela também recusa, antes de abrir qualquer conexão. A comparação usa o nome que o driver `pg` realmente conectaria, então `/%61geniza`, uma URL sem caminho com usuário `ageniza` e um `PGDATABASE=ageniza` herdado também são recusados.

Crie o banco uma vez, aplique as migrations nele e exporte as duas variáveis em todo shell que rodar migration ou teste:

```sh
docker exec ageniza-local-postgres-1 psql -U postgres -c "create database ageniza_meu"
export MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ageniza_meu
export DATABASE_URL=postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_meu
pnpm db:migrate
```

Para recomeçar, apague e recrie só esse banco (`drop database ageniza_meu`). O CI faz o mesmo com `ageniza_ci`. O comando de demonstração (`seed-demo`) é outra coisa: ele existe justamente para o banco `ageniza` do dono e mantém o próprio portão local descrito acima.

## Quando algo não sobe

- **`pnpm storage:start` falha e o contêiner nunca fica saudável** — o script despeja o log do contêiner antes de propagar o erro. A causa costuma estar ali, não no script.
- **Testes de integração com `ECONNREFUSED 127.0.0.1:54322`** — o PostgreSQL não está no ar. `pnpm db:start`.
- **Consulta volta vazia sem erro** — quase sempre é contexto de usuário ausente na transação, e a RLS está fazendo o trabalho dela. Não é bug de SQL. Ver o [ADR 0011](adr/0011-self-hosted-postgres-and-better-auth.md).
- **`pnpm test:scripts` falha no Windows com `SyntaxError: Invalid or unexpected token` num `.mjs` com `#!`** — o checkout gravou CRLF nele (`core.autocrlf=true`), e o vitest recusa o `\r` depois do shebang. Um checkout já existente não se corrige sozinho quando a regra do `.gitattributes` muda, porque o git não reescreve arquivo cujo conteúdo no índice não mudou. Para cada `.mjs` com `#!` que `git ls-files --eol scripts` mostre como `w/crlf`, rode `rm <arquivo> && git checkout -- <arquivo>`, e confira de novo com `git ls-files --eol scripts`: os `.mjs` com shebang têm de sair como `w/lf`. Issue #535.
- **`cli:agency` reclama de configuração** — as quatro variáveis do comando acima são obrigatórias. O comando é a ferramenta de operação e aceita o banco que a operação indicar, inclusive o serviço `postgres` da rede interna no VPS; quem exige loopback é o `seed:demo`, que é só de desenvolvimento.
