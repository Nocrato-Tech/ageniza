---
description: Consolida a entrevista do módulo em specs/<modulo>.md, o documento final do qual saem as issues.
argument-hint: <modulo>
---

Consolide tudo o que foi decidido sobre o módulo **$1** em `specs/$1.md`, a partir de `specs/TEMPLATE.md`.

## Fontes

- A conversa da entrevista (`/modulo-entrevista $1`), se ela aconteceu nesta sessão.
- As entradas de `docs/business/decisions/` que tocam o módulo.
- O que já existe em `apps/api/src/modules`, nas migrations e em `apps/web/src`.
- `specs/$1.md`, se já existir — atualize em vez de sobrescrever.

## Regras

- **Nada entra na SPEC que não tenha sido decidido.** Se você precisar preencher uma seção com suposição, ela não está pronta: vai para "Em aberto", com gatilho.
- Back e front ficam no mesmo documento. A separação acontece nas issues, não aqui.
- O esboço de tela é baixa fidelidade — o que existe e onde. Sem direção de arte.
- Cada regra da seção "Regras invioláveis" tem que ser verificável por um teste. Se não dá para testar, está vaga demais.
- A seção "Decisões registradas" é só índice: o texto da decisão vive em `docs/business/decisions/`, nunca duplicado aqui.
- Marque o `Status` com honestidade — `rascunho` enquanto o dono do produto não aprovou.

## Ao fim

Aponte explicitamente: o que a SPEC deixou em aberto, e quais itens da seção 9 marcaram mudança estrutural. Ofereça `/modulo-issues $1` como próximo passo.
