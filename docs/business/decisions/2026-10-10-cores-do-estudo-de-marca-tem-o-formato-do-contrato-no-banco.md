# As cores do estudo de marca têm o formato do contrato no banco

**Data.** 2026-10-10

**Estrutural.** Esta decisão é estrutural segundo [structural-changes.md](../structural-changes.md): altera uma tabela que já existe (`client_brand_sections`) e exige que as linhas existentes já estejam no formato (backfill).

**Contexto.** `client_brand_sections.colors` só conferia `jsonb_typeof(colors) = 'array'`. O `ageniza_app`, sob RLS, gravava qualquer elemento, e a leitura (`GET` do estudo de marca na agência e no portal) valida a resposta por `BrandColorSchema`: uma cor fora do contrato fazia a resposta inteira, com as sete seções e as personas, virar 500. Foi o que o `seed:demo` provocou na #471, ao gravar `{ nome, codigoHexadecimal }`, formato que `specs/clientes.md` descrevia em prosa (a linha foi corrigida para `{ name, hex }`). A #474 corrigiu o seed; a causa, o banco aceitar o que a leitura recusa, ficou na #476. A regra da casa é nunca 500.

**Decisão.**

1. **O banco recusa, na gravação, cor fora do contrato.** A migration `20261010000100_brand_colors_format.mjs` cria `app_private.brand_colors_valid(jsonb)` (`IMMUTABLE`, `search_path` fixo, sem `SECURITY DEFINER`, `EXECUTE` só para `ageniza_app`) e a constraint `client_brand_sections_colors_format`, que a chama sobre `colors`. Escritor errado (API, seed, importação futura, correção de dado) falha no `INSERT`/`UPDATE` com `23514`, em vez de gravar uma linha que quebra a leitura depois.
2. **A função é um espelho exato do contrato de escrita**, `BrandColorSchema` dentro de `BrandStudySectionUpdateRequestSchema` (`packages/contracts/src/clients.ts`): até 24 itens; cada item é um objeto com exatamente as chaves `name` e `hex`; `name` é texto de até 60 bytes UTF-8 e sem caractere de controle (U+0000 a U+001F e U+007F); `hex` casa `^#[0-9A-Fa-f]{6}$`. `NULL` continua aceito, e a lista vazia também.
3. **`name` vazio é aceito, porque o contrato aceita.** `BrandColorSchema` não tem mínimo nem `trim` no nome, então `{ "name": "", "hex": "#000000" }` e um nome só de espaços passam nos dois lados. Apertar isso é decisão de produto separada, e o espelho não a antecipa.
4. **A constraint é adicionada validada, sem `NOT VALID`.** Uma linha fora do formato barra a migration, em vez de ficar para trás derrubando a leitura. Não há backfill automático: a migration não sabe qual era a intenção de uma cor malformada e não apaga nem reescreve dado de cliente.
5. **O espelho é guardado por teste, não por convenção.** `apps/api/src/modules/clients/brand-colors-parity.integration.test.ts` fixa, caso a caso e por valor, o veredito esperado e exige que o `BrandColorSchema` e a função respondam igual; `packages/database/test/brand-colors-format.integration.test.ts` prova a constraint na tabela, como `ageniza_app` sob RLS e como dono.
6. **Apertar ou afrouxar `BrandColorSchema` passa a pedir uma migration nova** que substitua a função, com o backfill que o aperto exigir, junto com o ajuste do contrato e dos casos do teste de paridade. É o custo de ter o invariante no banco.

**Alternativa fechada.** Uma leitura que degrada só a seção ruim (devolver `colors: null` e registrar `log.error`) não foi adotada: deixa a linha corrompida no banco, exigiria mexer em `service.ts`, `portal-service.ts` e `sectionFilledSql` para o contador `filled` não divergir da seção vazia, esconde da agência e do portal que a cor foi perdida, e cada módulo futuro com coluna `jsonb` copiaria o remendo. Quem voltar a propor isso precisa de um motivo novo.

**Consequência.**

- Nenhuma rota, contrato ou resposta muda; `pnpm api:docs` não muda. A API só grava `colors` já validado por `BrandStudySectionUpdateRequestSchema`, então a constraint não adiciona recusa alcançável por entrada; o que ela cobre são os outros escritores.
- A leitura continua confiando na linha (o cast em `brandSectionFromRow` não muda), agora com o banco garantindo o formato. Toda lista que o banco aceita também passa no `BrandStudySectionSchema` da resposta, e o teste de paridade confere isso.
- **Linhas existentes.** Em CI e em banco novo não há linha fora do formato. O banco local `ageniza` do dono tem quatro linhas no formato antigo, gravadas pelo `seed:demo` anterior à #474: antes de migrar, o dono roda `pnpm seed:demo`, que as regrava no formato do contrato por `upsert`. Sem isso, `pnpm db:migrate` falha na `ADD CONSTRAINT`, o que é o comportamento desejado. Produção ainda não existe, e o seed recusa rodar nela.
- O que a API já recusava com `400` (nome acima de 60 bytes, mais de 24 cores, chave extra, `hex` fora de `#RRGGBB`) agora também não entra por nenhum outro caminho.

**Origem.** Issue #476; achado do Lupa na revisão do PR #474 (#471).

**Validação.** Validada pelo dono em 2026-10-10.
