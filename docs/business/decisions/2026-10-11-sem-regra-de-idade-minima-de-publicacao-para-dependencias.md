# Não há regra de idade mínima de publicação para dependências por enquanto

**Data.** 2026-10-11

**Contexto.** A revisão do PR #501 (#292, #306) anotou que a `fast-uri@4.2.2` tinha cerca de 15 horas de publicada quando entrou no `pnpm-lock.yaml`, e que outros pacotes transitivos do SDK da AWS (`@aws-sdk/token-providers@3.1149.0`, `@aws-sdk/core@3.978.2`, `@smithy/core@3.35.2` e outros) tinham um dia ou pouco mais. O repositório não tem política de idade mínima: uma versão recém-publicada, inclusive uma publicada por quem tomou a conta de um mantenedor, entra assim que o lockfile é regenerado. A #509 pediu para avaliar uma regra. O `pnpm` do repositório é o 9.15.4 (`packageManager` e `engines` `>=9.15.4 <10`), que não tem a opção `minimumReleaseAge`: ela só existe a partir do `pnpm` 10.16. Aplicar a regra com a ferramenta pronta exige trocar a versão do `pnpm` no `package.json`, nos Dockerfiles e no CI, o que é mudança de ferramental e não cabe dentro de uma issue de débito. As alternativas são um script de CI próprio que leia o lockfile e consulte o registro do `npm` (código nosso para manter, com falha de rede no CI) ou não ter a regra.

**Decisão.** Não se cria uma regra de idade mínima de publicação agora. Continua valendo o que já protege a entrada de uma dependência: o lockfile congela versão e `integrity`, `pnpm install --frozen-lockfile` no CI e nas imagens, `pnpm audit --prod` limpo nas severidades que a revisão de segurança exige, e o item "Supply chain" de `docs/security-review.md`, que a Coruja confere em todo PR que mexe em dependência. Quando o PR traz versões recém-publicadas, o corpo registra a idade delas e a decisão de aceitá-las, como o #501 deveria ter feito. Subir o `pnpm` para 10.16 ou mais com `minimumReleaseAge` fica para um PR à parte, quando o dono quiser.

**Alternativa fechada.** Subir o `pnpm` para 10.16 ou mais e ligar `minimumReleaseAge` não foi adotado agora: é mudança estrutural de ferramental (versão do gerenciador de pacotes no `package.json`, nos Dockerfiles e no CI) e merece issue e PR próprios. Também não se adotou o script de CI próprio. Quem quiser a regra depois deve abrir essa issue e dizer quantas horas ou dias de idade mínima aceita e quais pacotes ficam isentos (uma correção de segurança recém-publicada precisa poder entrar).

**Consequência.**

- Nada muda em `package.json`, no lockfile, nos Dockerfiles nem no CI.
- A idade de uma dependência nova continua sendo conferida na revisão, não por máquina.
- A decisão não impede uma regra futura: é um registro de que ela foi avaliada e adiada.

**Origem.** Issue #509, sugestão da revisão do Lupa no PR #501, decisão do dono em 2026-10-11 (opção C: não criar a regra agora, só registrar).

**Validação.** Validada pelo dono em 2026-10-11.
