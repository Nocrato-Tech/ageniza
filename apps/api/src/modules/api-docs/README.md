# Documentação da API (issue #182)

Gera, versiona e serve a documentação da API a partir dos schemas de `packages/contracts`.

- `pnpm api:docs` escreve `docs/api/openapi.json` (OpenAPI 3.1) e `docs/api/README.md` (resumo
  legível por módulo, com tabela de rotas, permissão e exemplos).
- `catalog.ts` é a única lista de rotas documentadas. `api-docs.integration.test.ts` constrói o app
  real e compara as rotas registradas com o catálogo, então rota nova sem documentação não passa.
- `document.ts` monta o documento com `@asteasolutions/zod-to-openapi`; cada exemplo é validado
  contra o schema que ilustra na hora da geração, e um exemplo desatualizado quebra o comando.
- `/docs` (Scalar) e `/docs/openapi.json` existem **apenas** quando `APP_ENV=local` — o padrão do
  `pnpm dev`. Em produção as rotas não são registradas (OWASP API9: não publicar inventário sem
  necessidade). O plugin e o gerador são `devDependencies` e nunca carregam em produção.

## Por que zod-to-openapi, e não `@fastify/swagger`

As rotas já validam entrada e saída com zod, via `parseRequest`/`parseResponse`. O caminho do
`@fastify/swagger` com type provider exigiria reescrever cada rota para declarar schema no Fastify —
duas fontes para o mesmo contrato, exatamente o que a issue proíbe. O `zod-to-openapi` consome os
mesmos objetos de `packages/contracts` que as rotas usam.

A interface é o Scalar (`@scalar/fastify-api-reference`), que serve o bundle do próprio pacote, sem
CDN de terceiro e sem o `@scarf/scarf` (telemetria de instalação) que o `swagger-ui-dist` traz.

## O que ficou de fora

- Autenticação na interface: o Scalar não envia o cookie de sessão, então as chamadas "try it" não
  funcionam em rota autenticada. A referência é para leitura.
- Gerar SDK ou cliente tipado a partir do documento.
