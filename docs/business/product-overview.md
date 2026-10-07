# Visão do produto

Para quem chegou agora e precisa entender o domínio antes do código. Os detalhes técnicos estão no [README](../../README.md) e nos [ADRs](../adr/); aqui está só o negócio.

## O que o Ageniza é

Uma plataforma de operação para **agências** que gerenciam conteúdo de redes sociais para seus **clientes**. A agência produz o conteúdo, o cliente aprova, e a plataforma publica.

Não é um produto de autoatendimento. Não existe cadastro público, e uma agência só passa a existir quando alguém da operação cria por comando interno. O produto atende a nossa agência e parceiros.

**Cobrança ainda não existe no sistema, mas está prevista.** Trial e cobrança por volume — clientes, colaboradores, armazenamento — são intenção registrada e não desenhada, e a nossa própria agência é isenta. Nada disso está implementado; ver a entrada correspondente em [decisions/](decisions/) antes de projetar qualquer coisa que dependa de plano.

## Os dois lados

O sistema tem dois contextos distintos, e essa separação é a coisa mais importante para entender o resto:

**Área da agência.** Onde os colaboradores trabalham: produzem conteúdo, convidam gente, gerenciam clientes. Quem acessa é membro da agência, com um papel.

**Portal do cliente.** Onde o cliente da agência entra para acompanhar e aprovar o que foi produzido para ele. Quem acessa é membro daquele cliente.

São contextos separados de propósito: **um colaborador da agência não entra no portal do cliente** só por ser da agência. Precisa de um vínculo de cliente próprio.

## Quem é quem

| | o que é |
|---|---|
| **Usuário** | a pessoa. É global: a mesma conta pode ter vínculos em várias agências e vários clientes |
| **Agência** | o tenant. Todo dado de negócio pertence a uma |
| **Cliente** | um cliente da agência, com portal próprio |
| **Owner** | quem é dono da agência. É propriedade da agência, **não** um papel |
| **Papel** | Admin, Gestor de conta, Produção, Vendas ou Financeiro |

Duas consequências que costumam surpreender:

- **Owner não é papel.** Ele tem todas as permissões da própria agência por ser dono, e recebe também um vínculo com papel Admin. Procurar "o papel de owner" no banco não leva a lugar nenhum.
- **A mesma pessoa pode estar em vários lugares.** Um usuário pode ser colaborador da agência A, colaborador da agência B e cliente de um terceiro — tudo com o mesmo login. Por isso o contexto é escolhido a cada acesso e nunca fica guardado na sessão.

## Como se entra

Só por convite. Existem três tipos:

1. **Ativação de agência** — criada por comando interno da operação. Quem recebe vira owner da agência nova.
2. **Convite de colaborador** — um Admin da agência convida alguém para a área interna, já com o papel definido.
3. **Convite de cliente** — um Admin convida alguém para o portal de um cliente específico.

Todo convite vale 7 dias, é de uso único, pode ser revogado, e reenviar invalida o anterior. O link chega por e-mail e o banco guarda apenas o hash — nem a operação consegue recuperar o token depois de enviado.

Quem aceita sem ter conta cria a conta no mesmo passo, aceitando Termos e Privacidade, que são versionados de forma independente e registrados com data e hora.

## Suspensão

Uma agência pode ser suspensa. Quando é:

- o acesso àquele tenant é negado na requisição seguinte, sem logout;
- os dados são preservados integralmente;
- convites pendentes dela deixam de ser aceitáveis;
- **os outros contextos da mesma pessoa continuam funcionando normalmente.**

Reativar devolve tudo. Não há perda de dados em nenhum momento.

## Mídia

O conteúdo inclui vídeo longo e Reels, em volume. Por isso o arquivo vai **direto do navegador para o armazenamento**, sem passar pelo servidor: o servidor apenas autoriza e depois confere o que chegou de fato.

Depois do upload confirmado, o worker gera **thumbnail e um preview em 720p**, para o cliente aprovar sem precisar baixar o original. O original nunca é convertido — é ele que vai para as redes.

Cada agência tem uma **quota** de armazenamento. Arquivo fora do tipo permitido, acima do tamanho ou além da quota é recusado e apagado.

## Onde as regras vivem

- Regras e decisões de negócio: [decisions/](decisions/) e as issues do GitHub.
- Decisões técnicas com consequência de longo prazo: [ADRs](../adr/).
- Invariantes que todo agente e toda pessoa deve respeitar: [`AGENTS.md`](../../AGENTS.md).

## Por onde começar no código

A API é um monolito modular; cada módulo de domínio fica em `apps/api/src/modules`:

| módulo | o que resolve |
|---|---|
| `auth` | login, sessão, recuperação de senha |
| `invitations` | os três tipos de convite, aceite e criação de conta |
| `tenancy` | as guardas que validam acesso à agência e ao cliente |
| `contexts` | listagem, resolução e troca de contexto depois do login |
| `media` | upload direto, confirmação e URLs assinadas |

O isolamento entre agências não depende só desse código: o PostgreSQL aplica *row level security* em toda tabela de negócio, e a aplicação nunca contorna isso. Uma falha de autorização na API ainda encontra o banco como segunda barreira. Vale ler o [ADR 0011](../adr/0011-self-hosted-postgres-and-better-auth.md) antes de mexer em qualquer coisa que toque dados de tenant.
