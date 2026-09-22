# Primeiros passos

Um roteiro para quem chegou ao projeto. Serve tanto para quem vai escrever código quanto para quem só precisa entender o produto.

## Se você quer entender o negócio

Leia nesta ordem, são cerca de vinte minutos:

1. [Visão do produto](business/product-overview.md) — o domínio, quem é quem, como se entra, o que acontece na suspensão.
2. [Decisões de negócio](business/decisions.md) — o que já foi decidido e por quê, incluindo o que ainda está pendente de validação.
3. As issues fechadas do GitHub — elas carregam as especificações completas, com critérios de aceite. As issues #31, #32 e #33 cobrem toda a autenticação e o modelo de tenant.

Nada disso exige saber programar.

## Se você vai escrever código

Comece pelos dois anteriores. O domínio explica escolhas que, sem ele, parecem arbitrárias. Depois:

1. [`AGENTS.md`](../AGENTS.md) — os invariantes do projeto. São curtos e valem para pessoas e agentes. Leia antes do primeiro commit.
2. [`README.md`](../README.md) — como rodar, estrutura do workspace, comandos.
3. [ADRs](adr/) — as decisões técnicas com consequência de longo prazo. O [0011](adr/0011-self-hosted-postgres-and-better-auth.md) é o mais importante: explica por que o PostgreSQL é próprio, como o RLS funciona aqui e por que a aplicação nunca o contorna.

### Subindo o ambiente

```sh
pnpm install
pnpm db:start        # PostgreSQL local
pnpm storage:start   # MinIO, substitui o R2 localmente
pnpm db:migrate
```

Para o fluxo completo de mídia e vídeo, o worker também precisa de `ffmpeg` disponível.

Antes de abrir qualquer PR:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm db:test:local
pnpm --filter @ageniza/api test:integration
pnpm --filter @ageniza/worker test:integration
```

### O que costuma pegar quem chega

- **RLS não é opcional.** Toda tabela de negócio força *row level security*, e a role da aplicação não tem permissão para contornar. Se uma consulta volta vazia sem erro, a causa provável é contexto de usuário ausente na transação, não um bug de SQL.
- **A checagem na API não substitui o banco.** As duas camadas existem de propósito. Nunca remova uma porque a outra já cobre.
- **Migration aplicada não se edita.** Corrige-se com outra. O histórico é sempre para frente.
- **Não invente regra de negócio.** Se a especificação não cobre o caso, escolha a interpretação mais conservadora e registre a dúvida em [decisions.md](business/decisions.md) ou na issue. Regra inventada em silêncio é a mais cara de descobrir depois.

## Se você trabalha com agentes neste repositório

Vale saber como o projeto foi construído, porque o processo é parte do resultado:

- As especificações vivem nas issues, com decisões fechadas e critérios de aceite explícitos. A qualidade da issue determina a qualidade do que sai.
- Entrega de agente passa por revisão independente antes do merge. Revisões acharam falhas reais que os testes escritos pelo próprio autor não pegavam — quem escreve o código escreve o teste com os mesmos pontos cegos.
- Decisão de negócio tomada durante uma sessão de trabalho é registrada em [decisions.md](business/decisions.md). O que fica só no histórico da conversa se perde.
