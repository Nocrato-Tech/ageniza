# O nome de uma cor com surrogate isolado é recusado no contrato

**Data.** 2026-10-10

**Contexto.** `{ "name": "x\ud800", "hex": "#FFFFFF" }` passava no `BrandColorSchema`: o contrato mede o tamanho em bytes UTF-8 e recusa só caractere de controle, e um surrogate isolado (metade de um par UTF-16, sem a outra) não é nem uma coisa nem outra. A API grava `colors` como `JSON.stringify(...)` seguido de `?::jsonb`, e o `JSON.stringify` mantém o surrogate isolado como o escape `\ud800`. O PostgreSQL recusa esse texto ao converter para `jsonb` (`22P02`), antes de a constraint `client_brand_sections_colors_format` rodar, e a rota respondia `500`. A Coruja executou o caso pela rota na revisão do PR #482 (#476). A regra da casa é nunca 500.

**Decisão.**

1. **O contrato recusa, com `400`, um nome de cor que tenha surrogate isolado.** `BrandColorSchema.name` ganha uma checagem de surrogate isolado: uma metade alta (U+D800 a U+DBFF) que não vem seguida de uma baixa, ou uma metade baixa (U+DC00 a U+DFFF) que não vem depois de uma alta. Um par bem formado, como um emoji, continua aceito.
2. **Recusar, não trocar.** A alternativa de trocar o surrogate por U+FFFD no servidor e gravar não foi adotada: grava um nome que a pessoa não digitou e esconde dela o erro do cliente que o gerou. A resposta `400` diz qual campo está errado.
3. **A função SQL `app_private.brand_colors_valid` não ganha regra nova.** Ela só vê o que o `jsonb` consegue guardar, e o `jsonb` não guarda surrogate isolado: o caso nunca chega a ser uma linha. O espelho exato entre contrato e função vale para todo valor que o `jsonb` representa; este caso é a exceção, e o teste de paridade o fixa como tal (contrato recusa, o banco responde `22P02` ao converter), como já faz com o NUL (`22P05`).
4. **Só o nome da cor muda.** É o único texto de entrada que vai para uma coluna `jsonb` (`hex` é limitado por regex a `#RRGGBB`, e as demais gravações em `jsonb` do repositório levam identificadores, não texto digitado). As seções de texto e as personas ficam em colunas `text`: lá o driver troca o surrogate isolado por U+FFFD, sem erro, e o contrato delas não muda nesta decisão.

**Alternativa fechada.** Aplicar a checagem em todo texto do contrato de clientes (`boundedText`, `boundedMultilineText`, o corpo das seções, as personas) não foi adotado nesta issue: tocaria campos que hoje respondem `200` com a substituição por U+FFFD, é uma mudança de comportamento de outros campos e merece decisão própria. Quem propuser isso precisa dizer se aceita que um texto antes aceito passe a responder `400`.

**Consequência.**

- `PUT .../brand-study/sections/colors` com surrogate isolado no nome responde `400` (`VALIDATION_ERROR`) e não grava nada; com um par bem formado, segue `200`.
- A resposta de leitura não muda: nenhuma linha existente tem surrogate isolado, porque o `jsonb` nunca o aceitou.
- Nenhuma migration, nenhuma resposta nova.

**Origem.** Issue #484; ressalva Média da revisão da Coruja no PR #482 (#476).

**Validação.** Pendente de validação do dono.
