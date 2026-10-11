# A imagem de produção leva só o runtime dos pacotes internos, e o database mantém o executor de migrations

**Data.** 2026-10-11

**Contexto.** O gate do fecho de produção da API (#305, PR #507) só conferia a lista fixa de pacotes da cadeia do vitest e pulava `node_modules`. Um pacote de desenvolvimento fora dessa cadeia (`tsx` movido para `dependencies`) levava o próprio `tsx` e o esbuild à imagem com saída 0, e `node_modules/@ageniza/*` levava 130 arquivos que o runtime nunca lê (`src`, `test`, `.turbo`, tsconfig e configs do vitest, 41 testes de integração do database). A revisão de segurança do PR #507 apontou os dois pontos (#510).

**Decisão.**

1. **Os `devDependencies` do workspace são proibidos na imagem da API.** O gate lê, a cada execução, o `package.json` da raiz e o de cada projeto de `apps/*` e `packages/*`, e soma esses nomes à lista fixa da cadeia do vitest, que continua escrita à mão porque nenhum `devDependency` a nomeia.
2. **Cada pacote interno (`config`, `contracts`, `core`, `database`, `email`) declara em `files` o `dist`, sem os testes compilados nem o `test-support`.** O `pnpm deploy` respeita `files`, então a imagem deixa de levar `src`, `test`, `.turbo` e configs de `@ageniza/*`, e o gate passa a olhar cada `@ageniza/*` que a API declara.
3. **O `@ageniza/database` lista também `bin` e `migrations`.** O `pnpm deploy` aplica `files` ao próprio projeto implantado, e a imagem de migrations (`infra/migrations/Dockerfile`) implanta esse pacote para rodar `bin/migrate.mjs`. A imagem da API leva essas duas pastas por consequência, e o gate as aceita só nesse pacote.

**Alternativa fechada.** Restringir o `files` do `@ageniza/database` ao `dist` deixaria a imagem da API sem as migrations, e a imagem de migrations vazia, que não aplicaria nada. Não foi mantido; separar o executor em outro pacote só para tirar 39 arquivos da imagem da API não compensa.

**Consequência.**

- Nenhuma tabela, rota, contrato ou migration muda; só `files` de cinco `package.json`, o gate de CI e o seu teste.
- A imagem da API carrega o mesmo `node_modules/.pnpm` de antes (181 entradas) e 205 arquivos de `@ageniza/*` em vez de 335.
- Um `devDependency` que passe a ser dependência real da API vira falha do gate, e a resolução é decidir no gate, não contorná-lo.

**Origem.** Issue #510; ressalvas baixas da revisão de segurança do PR #507.

**Validação.** Pendente de validação do dono.
