---
description: Deriva a history, as tasks, os pontos em aberto e os débitos do módulo a partir da SPEC.
argument-hint: <modulo> [--dry-run]
---

Leia `specs/$1.md` e derive dela o recorte de implementação no GitHub. O processo está em `docs/business/module-process.md`.

## O que gerar

- **Uma issue `tipo:history` por capacidade entregável.** Descreve o resultado do ponto de vista de quem usa, aponta para a seção da SPEC que a define, e lista as tasks.
- **Uma issue `tipo:task` por frente de trabalho.** Task que atravessaria API e interface vira duas — PR misturando as duas não tem revisão possível. Cada task carrega exatamente um `escopo:`.
- **Task de `escopo:web` carrega o esboço da tela no próprio corpo**, não só o link da SPEC: o wireframe, uma tabela dizendo o que cada elemento faz ali, e os estados que a tela precisa cobrir. É a especificação da tela: quem implementa trabalha a partir da issue e não deveria precisar abrir o repositório para saber o que construir. Link para a seção da SPEC continua, como origem — mas ele não substitui o esboço. A task não recebe rótulo de espera por design: o que a bloqueia é a dependência real, em geral a task de API, declarada em "Depende de". Enquanto a fundação do design system não existir no código, toda task de tela também espera essa decisão do dono do produto: ver a entrada de 2026-09-28 em `docs/business/decisions.md`.
- **Uma issue `em-aberto` por item da seção 10**, com o gatilho no corpo.
- **Uma issue `debito` por dívida reconhecida.**

Toda issue leva `modulo:$1`. Quem tocar algo marcado na seção 9 leva também `estrutural`, e o corpo aponta a entrada correspondente em `decisions.md`.

## Como escrever

- Aceite verificável, não desejo. "Colaborador sem `colaborador.convidar` recebe 403 na rota e não vê o botão" é aceite; "convite funciona corretamente" não é.
- Dependência explícita entre tasks, para quem pegar a issue sem ter estado na entrevista saber a ordem.
- Contexto suficiente para alguém que chegou agora: linke a seção da SPEC em vez de reescrevê-la, mas não deixe a issue vazia esperando que a pessoa leia tudo.

## Antes de criar

Mostre a árvore completa — history, tasks, abertos, débitos, com labels — e **espere aprovação**. Com `--dry-run`, pare aí e não crie nada.

Depois de criar, preencha a seção 12 da SPEC com os números das issues.
