# O nome do cliente não aceita emoji

**Data.** 2026-10-08

**Contexto.** A decisão de 2026-10-08 sobre invisíveis no nome do cliente ([`2026-10-08-invisiveis-recusados-no-nome-do-cliente`](./2026-10-08-invisiveis-recusados-no-nome-do-cliente.md), issue #427) abriu uma exceção: U+FE0F (VS16) era aceito logo depois de um pictograma, para que o nome de um cliente pudesse ter um emoji como "❤️". A revisão de segurança do PR #431 mostrou que a exceção deixa passar homônimos que o índice de nome único não enxerga: com `Casa 🏠` ativo, o cadastro aceitou (201) `Casa 🏠️`, o mesmo pictograma com um VS16 redundante, que se desenha igual. O ZWJ entre um pictograma e uma letra latina, ou entre dois pictogramas, tem o mesmo efeito: `Cafe ❤Central` com e sem ZWJ deram 201 e 201. O dono decidiu não manter o emoji no nome do cliente em vez de cercar cada sequência (issue #436, itens B2 e B3).

**Decisão.** O nome do cliente (`ClientNameSchema`, cadastro e edição) recusa todo caractere `Extended_Pictographic` do Unicode. Com isso, o VS16 deixa de ter exceção e é recusado em qualquer posição, e o ZWJ ao lado de um pictograma também, porque o pictograma já não existe no nome. Esta decisão substitui a exceção do VS16 da decisão de 2026-10-08 ligada acima; o restante daquela decisão continua valendo (os demais invisíveis, o braille em branco e os tags). `createDisplayNameSchema` e os nomes de pessoas, o cargo, a razão social e os contatos não mudam: continuam aceitando emoji.

**Consequência.** O `POST` e o `PATCH` de cliente respondem `400` para `Café ❤️`, `Casa 🏠`, `Casa 🏠️` e `Cafe ❤Central` (com ZWJ). `Extended_Pictographic` inclui, além dos emojis, símbolos que o Unicode trata como pictográficos, como ©, ® e ™, e também ★ e ✔. Um nome de cliente com qualquer um deles passa a ser recusado. Bandeiras (indicadores regionais) e teclas (dígito, VS16 e U+20E3) não são `Extended_Pictographic`: as bandeiras seguem aceitas e as teclas já eram recusadas pelo VS16. Nomes já gravados não são corrigidos (sem backfill, sem migration), e editar o cliente sem mexer no nome continua possível porque o `PATCH` só valida o campo enviado.

**Origem.** Issue #436, ressalvas B2 e B3 da revisão de segurança do PR #431. Decisão do dono registrada no comentário da issue, em 2026-10-08.

**Validação.** Validada pelo dono em 2026-10-08.
