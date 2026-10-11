# A fast-uri 4.x fica na 4.2.2, sem override que a fixe na 4.1.5

**Data.** 2026-10-11

**Contexto.** O PR #501 (#292) deixou a `fast-uri` do lockfile em 4.2.2 (publicada em 2026-10-10 10:12 UTC) e 3.1.8. A revisão do Lupa observou que a 4.2.2 era recente, que traz três mudanças de comportamento de URI (rejeita referências inválidas, codifica caracteres de host inválidos, preserva *dot segments* em URN) e que as duas advisories da linha 4.x (GHSA-hrr3-gc8f-f4qj e GHSA-jvvf-x445-j334) já são corrigidas na 4.1.5 (publicada em 2026-09-15). A 4.x chega por `@fastify/ajv-compiler` e `fast-json-stringify`, que declaram `fast-uri@^4.0.0`, e por isso entra na validação de toda requisição e na serialização de toda resposta. A conferência de 2026-10-11 no registro das advisories do GitHub (`gh api advisories?affects=fast-uri`) não lista advisory contra a 4.2.2, nem contra a 4.1.5, nem contra a 3.1.8; as mais novas da linha 4.x são as duas acima, ambas corrigidas na 4.1.5.

**Decisão.** A `fast-uri` 4.x continua na 4.2.2. Não se cria `pnpm.overrides` para fixar a 4.1.5. O lockfile fica como está.

**Alternativa fechada.** Fixar a 4.1.5 (a menor versão que fecha o aviso) exigiria um override em `package.json` ou editar o lockfile à mão, já que os dois pais pedem `^4.0.0`. Um override passa a valer para sempre e bloqueia a próxima correção de segurança da linha 4.x até alguém lembrar de tirá-lo; o lockfile editado à mão é desfeito pela próxima regeneração. O ganho, uma versão com quatro semanas em vez de um dia, não paga isso, e a 4.2.2 não tem advisory. Quem propuser fixar de novo precisa mostrar uma advisory ou um defeito observado na 4.2.2.

**Consequência.**

- Nenhuma mudança em `package.json` nem no lockfile.
- Uma advisory futura contra a 4.2.2 é tratada como qualquer outra: sobe-se a versão dentro do `^4.0.0` pelo lockfile.
- A idade das versões novas continua conferida na revisão (ver `2026-10-11-sem-regra-de-idade-minima-de-publicacao-para-dependencias.md`).

**Origem.** Issue #509, sugestão da revisão do Lupa no PR #501, decisão do dono em 2026-10-11 (manter a 4.2.2, sem override, com a idade e a avaliação registradas no PR).

**Validação.** Validada pelo dono em 2026-10-11.
