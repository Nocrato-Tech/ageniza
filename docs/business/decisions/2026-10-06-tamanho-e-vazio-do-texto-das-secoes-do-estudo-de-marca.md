# Tamanho e vazio do texto das seções do estudo de marca
**Data.** 2026-10-06

**Contexto.** A #127 implementa as rotas do estudo de marca. A SPEC (`specs/clientes.md`, seção 3) define as seções como "texto livre" e **não** fixa limite de tamanho nem regra de vazio para `client_brand_sections.body`. A coluna existe desde a #122 com `octet_length(body) <= 20000`, e o preenchimento (`filled`) já ignora texto só com espaços (`btrim`). Sem validação na rota, um texto multibyte acima do teto da coluna viraria 500, e só espaços gravaria uma linha que nenhuma leitura conta como conteúdo.

**Decisão.** O texto das seções é aparado (trim), recusado quando fica vazio (só espaços, inclusive NBSP, dá `400`) e limitado a **20.000 bytes**, não caracteres — é o `octet_length` da coluna `body` (`packages/database/migrations/20260928000100_clients_module.mjs:130`). Em português com acento, 20.000 bytes dão entre cerca de 10 mil e 20 mil caracteres, porque cada caractere acentuado ocupa dois ou três. O `PUT` devolve o texto já aparado e aceita quebras de linha (`\n`, `\r` e `\t`), recusando os demais controles. A mesma lógica de limite em bytes vale para os campos de persona: `name` até **120 bytes** (aparado, não vazio), `description`, `pains`, `desires` e `objections` até **5.000 bytes** (multilinha), e `colors` no máximo **24** itens.

**Consequência.** O teto acompanha a coluna por construção: **baixá-lo** é mudança de uma constante (`BrandSectionTextSchema`, em `packages/contracts/src/clients.ts`) e do teste correspondente, sem migration; **subir acima da coluna exige migration**, porque é o `octet_length` que decide. O texto da seção é aparado (trim); os campos multilinha da persona (`description`, `pains`, `desires`, `objections`) são gravados como vêm, sem trim — o nome da persona continua aparado.

**Origem.** Issue #127 e PR #282. **Pendente de validação pelo dono do produto** — a SPEC não define teto nem regra de vazio para o texto das seções.

