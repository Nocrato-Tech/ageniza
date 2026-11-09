<!--
Um PR por escopo, mesmo grande: as subtarefas (API, tela, migration) são revisadas antes de entrar na integração, e cada issue leva o seu `Closes #N` e o aceite item a item na tabela aceite → teste → mutação.
O fluxo completo está em CONTRIBUTING.md.
-->

## Por quê

<!-- O problema que este PR resolve. Se houver issue, linke; cada issue do escopo leva a sua linha `Closes #N`. Se a razão não estiver na issue, escreva aqui. -->

<!-- Closes #N — uma linha por issue agrupada; a palavra-chave tem de vir imediatamente antes do número. -->

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
