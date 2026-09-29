# Primeiros passos

Um roteiro para quem chegou ao projeto. Serve tanto para quem vai escrever código quanto para quem só precisa entender o produto.

## Se você quer entender o negócio

Leia nesta ordem, são cerca de vinte minutos:

1. [Visão do produto](business/product-overview.md) — o domínio, quem é quem, como se entra, o que acontece na suspensão.
2. [Decisões de negócio](business/decisions.md) — o que já foi decidido e por quê, incluindo o que ainda está pendente de validação.
3. As [SPECs](../specs/) dos módulos já fechados — elas dizem o que cada módulo faz, até o esboço das telas.

Nada disso exige saber programar.

## Se você vai escrever código

Comece pelos dois anteriores. O domínio explica escolhas que, sem ele, parecem arbitrárias. Depois:

1. [`AGENTS.md`](../AGENTS.md) — os invariantes do projeto. São curtos e valem para pessoas e agentes. Leia antes do primeiro commit.
2. [`CONTRIBUTING.md`](../CONTRIBUTING.md) — branch, commit, PR, revisão, e o que fazer quando o CI reprova.
3. [Como um módulo é fechado](business/module-process.md) — **o processo de trabalho daqui**. Sem isso você vai pegar uma issue sem entender de onde ela veio.
4. [Mudanças estruturais](business/structural-changes.md) — o que custa caro mudar depois. Obrigatório antes de implementar algo novo.
5. [Ambiente local](local-environment.md) — como sair do clone para um ambiente em que dá para entrar no produto.
6. [Anatomia de um módulo](module-anatomy.md) — o molde que todo módulo da API segue.
7. [ADRs](adr/) — as decisões técnicas de consequência longa. O [0011](adr/0011-self-hosted-postgres-and-better-auth.md) é o mais importante: explica por que o PostgreSQL é próprio, como o RLS funciona aqui, e por que a aplicação nunca o contorna.

O [README](../README.md) tem a estrutura do workspace e a lista de comandos.

## Como o trabalho acontece aqui

Este projeto **não começa por código**. A ordem é sempre a mesma:

```
entrevista → SPEC em specs/ → épico, histories e tasks → implementação
```

Três consequências práticas para quem chega:

- **Toda task aponta para a seção de uma SPEC.** Se você pegou uma e não encontra a SPEC, ou ela existe e você não achou, ou a task nasceu fora do processo. Pergunte antes de codar.
- **Task de interface não espera o designer.** Ela traz o esboço da tela no corpo, e esse esboço é a especificação: você implementa a partir dele, só com componentes e tokens do [design system](design-system.md), e o designer refina a tela depois do merge. Não é licença para inventar o layout.
- **Módulo novo não abre** enquanto o anterior não estiver com SPEC aprovada e recortado em issues.

O andamento fica no quadro [Ageniza — MVP](https://github.com/orgs/Nocrato-Tech/projects/1) — a coluna diz em que etapa a coisa está, e o campo **Onda** diz o que dá para pegar agora sem esperar ninguém. As regras estão em [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Os rótulos das issues: `tipo:epico` · `tipo:history` · `tipo:task` · `escopo:api|web|db|infra` · `modulo:<nome>` · `estrutural` · `em-aberto` · `debito` · `refino-design`.

## Subindo o ambiente

O roteiro completo, testado ponta a ponta, está em [Ambiente local](local-environment.md). O resumo:

```sh
pnpm install
pnpm db:start        # PostgreSQL local
pnpm storage:start   # LocalStack, substitui o R2 localmente
pnpm db:migrate
```

**O banco sobe vazio, e não existe cadastro público.** Para ter uma agência e um convite com que trabalhar, use `pnpm --filter @ageniza/api cli:agency create` — o passo a passo, com as variáveis necessárias e como ler o e-mail no Mailpit, está no guia de ambiente local. É o ponto em que todo mundo trava na primeira semana.

Antes de abrir qualquer PR:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm db:test:local
pnpm --filter @ageniza/api test:integration
pnpm --filter @ageniza/worker test:integration
```

As duas últimas exigem Docker no ar, e a do worker também exige `ffmpeg`.

## O que costuma pegar quem chega

- **RLS não é opcional.** Toda tabela de negócio força *row level security*, e a role da aplicação não tem permissão para contornar. Se uma consulta volta vazia sem erro, a causa provável é contexto de usuário ausente na transação, não um bug de SQL.
- **A checagem na API não substitui o banco.** As duas camadas existem de propósito. Nunca remova uma porque a outra já cobre.
- **Migration aplicada não se edita.** Corrige-se com outra. O histórico é sempre para frente.
- **Não invente regra de negócio.** Se a especificação não cobre o caso, escolha a interpretação mais conservadora e registre a dúvida em [decisions.md](business/decisions.md) ou na issue. Regra inventada em silêncio é a mais cara de descobrir depois, porque parece comportamento.
- **Idioma:** código e comentários em inglês, documentação de negócio em português, mensagens ao usuário em português. O commit segue o idioma do que ele muda.
- **Comentário é exceção.** Comente o que o código não consegue dizer — uma restrição não óbvia, a razão de uma decisão surpreendente. Nunca o que a próxima linha já diz.

## Se você trabalha com agentes neste repositório

O processo é parte do resultado, e boa parte deste repositório foi construída assim.

**O que o agente lê, e o que ele não lê.** `AGENTS.md`, `docs/business/` e as issues são autoritativos. O **Notion não é lido por agente nenhum** — o que estiver lá é insumo histórico, e precisa ser trazido para cá antes de valer.

**Os comandos do harness** conduzem as quatro fases, e estão em `.claude/commands/`:

| comando | fase |
|---|---|
| `/modulo-entrevista <nome>` | a entrevista, conduzida em rodadas |
| `/modulo-spec <nome>` | consolida a conversa na SPEC |
| `/modulo-issues <nome>` | deriva épico, histories, tasks, abertos e débitos |

**As regras que valem em qualquer sessão com agente:**

- **Decisão é de quem é dono do produto.** O agente pergunta, propõe e registra. Nada vira decisão porque pareceu coerente para quem estava implementando.
- **Fato é trabalho do agente; decisão é sua.** Ele não deveria perguntar o que dá para descobrir lendo o repositório.
- **Decisão fechada é registrada na hora**, em `decisions.md`, marcada como pendente de validação enquanto ninguém validou. O que fica só no histórico da conversa se perde.
- **Ponto em aberto precisa de gatilho** — o evento que obriga a decisão, não uma data. Sem gatilho é dívida invisível.
- **Entrega de agente passa por revisão independente**, como qualquer outra. Revisões aqui acharam falhas reais que os testes escritos pelo próprio autor não pegavam: quem escreve o código escreve o teste com os mesmos pontos cegos.
- **Mudança estrutural para a sessão.** O agente é obrigado a parar, registrar e só então implementar — e há um gate de CI que reprova migration estrutural sem decisão registrada.

**O que desconfiar numa entrega de agente:** teste que exercita o caminho feliz e nada mais; regra de negócio que apareceu do nada e não está em nenhuma SPEC; comentário explicando o óbvio; e migration que altera uma tabela existente sem entrada correspondente em `decisions.md`.
