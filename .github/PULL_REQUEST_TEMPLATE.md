<!--
Um PR, um assunto: pode juntar issues do mesmo tema e da mesma camada, cada uma com o seu `Closes #N` e o aceite item a item, até ~800 linhas de diff de código. API e interface são PRs separados; migration não vem com código de API nem de tela.
O fluxo completo está em CONTRIBUTING.md.
-->

## Por quê

<!-- O problema que este PR resolve. Se houver issue, linke; se o PR agrupa issues do mesmo tema e da mesma camada, cada uma leva a sua linha `Closes #N`. Se a razão não estiver na issue, escreva aqui. -->

## O que muda

<!-- O que passa a ser verdade depois do merge. Não liste arquivos: o diff já faz isso. -->

## Como foi verificado

<!-- Comandos que você rodou e o que eles disseram. "Testado" não é verificação. -->

## Verificação estrutural

Ver [structural-changes.md](../blob/develop/docs/business/structural-changes.md). Se marcar qualquer item, a decisão precisa estar registrada em `docs/business/decisions/` **antes** desta implementação.

- [ ] altera tabela que já existe
- [ ] muda formato de resposta que outras rotas copiam
- [ ] mexe em RLS de mais de um módulo
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

## Antes de pedir revisão

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
- [ ] as suítes de integração que a mudança alcança
- [ ] a SPEC foi corrigida, se a implementação divergiu dela
- [ ] decisão de negócio tomada no caminho está em `docs/business/decisions/`
- [ ] a mutação que prova cada aceite está listada em "Como foi verificado"
