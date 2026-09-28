---
description: Conduz a entrevista de escopo de um módulo, bloco a bloco, registrando as decisões conforme elas fecham.
argument-hint: <modulo> [--retomar]
---

Você vai conduzir a entrevista de escopo do módulo **$1**. Seu papel é **perguntar, propor e registrar** — nunca decidir. Quem aprova é o dono do produto.

**Carregue a skill `grilling` e conduza a sessão inteira no método dela**: árvore de decisão trabalhada em rodadas, perguntando toda a fronteira de uma vez, numerada, cada pergunta com a sua recomendação. Os sete blocos abaixo são a **ordem** da árvore; a `grilling` é o **método** dentro de cada nível.

## Antes de perguntar qualquer coisa

1. Leia `docs/business/module-process.md`, `docs/business/product-overview.md` e `docs/business/structural-changes.md`.
2. Leia as entradas de `docs/business/decisions.md` que tocam este módulo.
3. Verifique o que já existe implementado: `apps/api/src/modules`, as migrations e `apps/web/src`. Uma entrevista que ignora o que já foi construído produz escopo que não encaixa.
4. Se já existir `specs/$1.md`, leia e continue de onde parou em vez de recomeçar.

Abra dizendo, em poucas linhas, o que você encontrou que já restringe este módulo. Não resuma o que o usuário já sabe.

## Bloco 0 — o fluxo pela ótica de quem usa

**Antes da primeira rodada de grill, faça uma pergunta aberta**: como este módulo deve funcionar na prática, e quais telas o usuário imagina. Uma pergunta, ampla, sem opções numeradas — é conversa, não rodada.

Isso existe porque o bloco de UX é o **sétimo** assunto: sem esta abertura, uma capacidade que o backend não tem só aparece no fim, depois de a sessão inteira ter decidido em cima do que já existe. Aqui ela aparece antes de custar.

O que você colhe é **intenção e inventário de telas**, não desenho: que telas existem, o que a pessoa faz em cada uma, o que ela espera ver. Nada de layout, e nada de decisão fechada — o que sair daqui é refinado pelos blocos seguintes contra os contratos e as regras que já existem.

Quando a resposta revelar algo que a API não faz, diga isso na hora e trate como **capacidade nova**: ela é escopo a decidir, não detalhe de tela.

## O roteiro

Sete blocos, nesta ordem — que é a ordem do custo de errar. Não pule para o seguinte enquanto o atual tiver buraco.

1. **Propósito** — o que resolve e o que explicitamente não resolve.
2. **Atores e autorização** — quem faz o quê, em permissões nomeadas.
3. **Entidades e campos** — invariante de domínio, não campo de formulário.
4. **Estados e transições** — o que é legítimo e o que cada transição exige.
5. **Regras invioláveis** — o que nunca pode acontecer. Vira teste.
6. **UX** — fecha o esboço das telas levantadas no bloco 0: o que mostram, o que fazem com os dados, o que muda por papel, e os estados vazio, carregando, erro e sem permissão. Abra este bloco pelo *Intent First* da skill `interface-design` — quem é a pessoa concreta que usa, o verbo concreto que ela precisa cumprir, e como aquilo deve sentir. O resto daquela skill é craft visual e não entra aqui.
7. **Impacto estrutural** — confronte com `structural-changes.md`, item por item.

## Como conduzir

- Pergunta cuja resposta depende de outra pergunta ainda aberta pertence à **rodada seguinte**, nunca à atual.
- **Fato é trabalho seu, decisão é do usuário.** Nunca pergunte o que você pode descobrir lendo o repositório.
- **Insista.** Resposta que abre um buraco é para ser cutucada antes de seguir, não anotada. Se a resposta contradiz algo já decidido ou já implementado, diga qual e onde.
- Proponha uma opção com recomendação quando o usuário estiver travado — nunca um leque de alternativas sem posição.
- **UX é esboço.** Quais telas, com o quê, para quem. Se a conversa derivar para cor, tipografia ou espaçamento, traga de volta: isso vem do [design system](../../docs/design-system.md) e do refino do designer.
- Quando não houver resposta ainda, não invente: vai para "Em aberto", e o item **só é válido com gatilho** — o evento que obriga a decisão, não uma data.
- Não invente regra de negócio. `AGENTS.md`, as issues e `docs/business/` são autoritativos; o Notion é insumo histórico, não fonte de verdade.

## Registrar durante a sessão

**Decisão fechada é escrita na hora**, em `docs/business/decisions.md`, com data, título, contexto, decisão, consequência e origem. Marque **pendente de validação** quando ninguém tiver validado ainda.

Se o bloco 7 acusar mudança estrutural, **pare o assunto ali**: registre a decisão dizendo explicitamente que é estrutural, antes de qualquer conversa de implementação.

## Ao fim

A sessão termina quando a fronteira esvazia — todo ramo visitado, nada assumido em silêncio.

Diga o que ficou fechado, o que ficou em aberto com seus gatilhos, e o que virou estrutural. Ofereça `/modulo-spec $1` como próximo passo — não execute sozinho.
