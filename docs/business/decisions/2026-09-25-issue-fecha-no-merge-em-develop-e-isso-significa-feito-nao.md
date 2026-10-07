# Issue fecha no merge em `develop`, e isso significa "feito", não "no ar"

**Data.** 2026-09-25

**Contexto.** O GitHub fecha uma issue referenciada apenas quando o pull request entra na **branch padrão**, que aqui é `main`. Todo pull request de trabalho vai para `develop`, então `Closes #123` **nunca disparou** neste repositório — a #85 foi implementada, mergeada, e continuou aberta sem ninguém notar. Com dezenas de tasks, o quadro mostraria como pendente um monte de trabalho pronto, e deixaria de ser confiável.

**Decisão.** O workflow `Close referenced issues` fecha as issues referenciadas no corpo do pull request quando ele é mergeado em `develop`. Aceita as duas línguas — `Closes`, `Fixes`, `Resolves`, `Fecha`, `Encerra` —, ignora menção solta e ignora referência dentro de bloco de código, porque exemplo em documentação não é intenção. A lógica fica em `scripts/ci/closing-references.mjs`, com teste.

**Issue fechada significa "feito e revisado", não "em produção".** O card permanece em *Pronto para subir* até a promoção para `main` movê-lo para *Em produção*: quem quer saber o que está no ar olha a coluna, não o estado da issue.

**Consequência.** A alternativa — fechar só na promoção para produção — exigiria um **token pessoal guardado como secret**, porque o `GITHUB_TOKEN` padrão não escreve em projeto de organização. Uma credencial a mais para rotacionar, por uma diferença de poucos dias, num sinal que a coluna já dá. O movimento `develop → Pronto para subir` sai de graça pela automação nativa do Projects.

**Origem.** Decidido em sessão.

