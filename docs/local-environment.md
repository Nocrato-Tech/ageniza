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
- **`cli:agency` reclama de configuração** — as quatro variáveis do comando acima são obrigatórias, e ele recusa qualquer `MIGRATION_DATABASE_URL` que não aponte para loopback.
