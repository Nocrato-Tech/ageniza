<!--
Um PR, um assunto. API e interface são PRs separados; migration vem sozinha.
O fluxo completo está em CONTRIBUTING.md.
-->

## Por quê

<!-- O problema que este PR resolve. Se houver issue, linke; se a razão não estiver nela, escreva aqui. -->

## O que muda

<!-- O que passa a ser verdade depois do merge. Não liste arquivos: o diff já faz isso. -->

## Como foi verificado

<!-- Comandos que você rodou e o que eles disseram. "Testado" não é verificação. -->

## Verificação estrutural

Ver [structural-changes.md](../blob/develop/docs/business/structural-changes.md). Se marcar qualquer item, a decisão precisa estar registrada em `decisions.md` **antes** desta implementação.

- [ ] altera tabela que já existe
- [ ] muda formato de resposta que outras rotas copiam
- [ ] mexe em RLS de mais de um módulo
- [ ] muda como a autorização é avaliada
- [ ] exigiria backfill

## Antes de pedir revisão

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
- [ ] as suítes de integração que a mudança alcança
- [ ] a SPEC foi corrigida, se a implementação divergiu dela
- [ ] decisão de negócio tomada no caminho está em `decisions.md`
- [ ] a mutação que prova cada aceite está listada em "Como foi verificado"
