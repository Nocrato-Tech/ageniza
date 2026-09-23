---
description: Conduz a entrevista de escopo de um módulo, bloco a bloco, registrando as decisões conforme elas fecham.
argument-hint: <modulo> [--retomar]
---

Você vai conduzir a entrevista de escopo do módulo **$1**. Seu papel é **perguntar, propor e registrar** — nunca decidir. Quem aprova é o dono do produto.

## Antes de perguntar qualquer coisa

1. Leia `docs/business/module-process.md`, `docs/business/product-overview.md` e `docs/business/structural-changes.md`.
2. Leia as entradas de `docs/business/decisions.md` que tocam este módulo.
3. Verifique o que já existe implementado: `apps/api/src/modules`, as migrations e `apps/web/src`. Uma entrevista que ignora o que já foi construído produz escopo que não encaixa.
4. Se já existir `specs/$1.md`, leia e continue de onde parou em vez de recomeçar.

Abra dizendo, em poucas linhas, o que você encontrou que já restringe este módulo. Não resuma o que o usuário já sabe.

## O roteiro

Sete blocos, nesta ordem — que é a ordem do custo de errar. Não pule para o seguinte enquanto o atual tiver buraco.

1. **Propósito** — o que resolve e o que explicitamente não resolve.
2. **Atores e autorização** — quem faz o quê, em permissões nomeadas.
3. **Entidades e campos** — invariante de domínio, não campo de formulário.
4. **Estados e transições** — o que é legítimo e o que cada transição exige.
5. **Regras invioláveis** — o que nunca pode acontecer. Vira teste.
6. **UX** — quais telas, o que mostram, o que muda por papel, e os estados vazio, carregando, erro e sem permissão.
7. **Impacto estrutural** — confronte com `structural-changes.md`, item por item.

## Como conduzir

- Uma pergunta de cada vez quando ela depende da resposta anterior; um bloco de cada vez quando não depende.
- **Insista.** Resposta que abre um buraco é para ser cutucada antes de seguir, não anotada. Se a resposta contradiz algo já decidido ou já implementado, diga qual e onde.
- Proponha uma opção com recomendação quando o usuário estiver travado — nunca um leque de alternativas sem posição.
- **UX é esboço.** Quais telas, com o quê, para quem. Se a conversa derivar para cor, tipografia ou espaçamento, traga de volta: isso é trabalho do designer.
- Quando não houver resposta ainda, não invente: vai para "Em aberto", e o item **só é válido com gatilho** — o evento que obriga a decisão, não uma data.
- Não invente regra de negócio. `AGENTS.md`, as issues e `docs/business/` são autoritativos; o Notion é insumo histórico, não fonte de verdade.

## Registrar durante a sessão

**Decisão fechada é escrita na hora**, em `docs/business/decisions.md`, com data, título, contexto, decisão, consequência e origem. Marque **pendente de validação** quando ninguém tiver validado ainda.

Se o bloco 7 acusar mudança estrutural, **pare o assunto ali**: registre a decisão dizendo explicitamente que é estrutural, antes de qualquer conversa de implementação.

## Ao fim

Diga o que ficou fechado, o que ficou em aberto com seus gatilhos, e o que virou estrutural. Ofereça `/modulo-spec $1` como próximo passo — não execute sozinho.
