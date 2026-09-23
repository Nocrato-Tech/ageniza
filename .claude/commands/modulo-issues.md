---
description: Deriva a history, as tasks, os pontos em aberto e os débitos do módulo a partir da SPEC.
argument-hint: <modulo> [--dry-run]
---

Leia `specs/$1.md` e derive dela o recorte de implementação no GitHub. O processo está em `docs/business/module-process.md`.

## O que gerar

- **Uma issue `tipo:history` por capacidade entregável.** Descreve o resultado do ponto de vista de quem usa, aponta para a seção da SPEC que a define, e lista as tasks.
- **Uma issue `tipo:task` por frente de trabalho.** Task que atravessaria API e interface vira duas — PR misturando as duas não tem revisão possível. Cada task carrega exatamente um `escopo:`.
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
