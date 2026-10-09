# Como contribuir

Este documento cobre o fluxo de trabalho: branch, commit, PR, revisão. O que **pode** ser construído, e quando, está em [Como um módulo é fechado](docs/business/module-process.md). Os invariantes que ninguém contraria estão em [`AGENTS.md`](AGENTS.md).

## Antes de escrever a primeira linha

1. [`docs/onboarding.md`](docs/onboarding.md) — o roteiro de leitura.
2. [`AGENTS.md`](AGENTS.md) — invariantes. Curto, e vale para pessoas e agentes.
3. [`docs/business/structural-changes.md`](docs/business/structural-changes.md) — obrigatório antes de implementar qualquer coisa nova.

## O portão: nada se implementa sem SPEC

Módulo novo **não começa** por código. Ele passa por entrevista, vira uma SPEC em `specs/`, e só então é recortado em issues. Se você pegou uma task e não encontra a SPEC dela, pare e pergunte: ou a SPEC existe e você não achou, ou a task nasceu fora do processo.

Uma **task** de implementação já chega com aceite verificável e a seção da SPEC que a define. Se ela não tiver isso, ela não está pronta para ser pega.

Task de interface (`escopo:web`) traz o esboço da tela no corpo, e ele é a **especificação**: o wireframe e a tabela de elementos dizem o que existe e o que cada coisa faz, e a implementação cobre todos os estados que o esboço lista. Use só tokens e componentes definidos em [`docs/design-system.md`](docs/design-system.md); nada de estilo avulso, nem layout inventado. O designer **refina a tela depois do merge**, e a tela mergeada que espera esse refino leva **`refino-design`**.

## Branch

Saia sempre de `develop` atualizado. Nunca faça push em `main` ou `develop`: existe um hook que recusa, e um workflow que abre issue quando alguém passa por cima.

```sh
git checkout develop && git pull
git checkout -b <tipo>/<assunto-curto>
```

| prefixo | para quê |
|---|---|
| `feature/` | capacidade nova |
| `fix/` | correção |
| `refactor/` | mudança sem alteração de comportamento |
| `docs/` | documentação, SPEC, decisão |
| `ci/` | pipeline e automação |
| `hotfix/` | **exceção de produção**, sai de `main` e volta para `main` |

`hotfix/*` é o único que não passa por `develop`, e ele obriga um PR de reconciliação para `develop` logo depois — sem isso, a próxima promoção perde a correção.

## Commit

Formato: `<tipo>: <o que muda, no imperativo>`.

**O idioma segue o que o commit muda:** código em **inglês**, documentação de negócio em **português**. Um commit que mistura os dois é sinal de que deveriam ser dois commits.

```
feat(api): reject a login that resolves to no context
docs: registrar as decisões da entrevista de colaboradores
```

O corpo do commit explica **por que**, não o que — o diff já diz o que. Vale mais uma frase sobre a alternativa descartada do que três sobre os arquivos tocados.

## Pull request

Todo PR vai para `develop`, exceto promoção de release e hotfix.

O corpo responde três coisas: **por que** existe, **o que muda**, e **como foi verificado**. O template preenche isso. O que ele cobra, e o revisor também:

- **Um PR, um assunto — que pode juntar issues do mesmo tema e da mesma camada.** Mesmo tema é o mesmo módulo ou épico; mesma camada é o mesmo `escopo:` (`db`, `api`, `web`, `infra`). Um PR pode agrupar issues assim, cada uma com o seu `Closes #N` e o aceite item a item no corpo, até **~800 linhas de diff de código** — produção e testes; não contam gerados, lockfile nem o `openapi.json` gerado. Acima disso, dividir. Se o título precisa de "e" para juntar temas ou camadas diferentes, são dois PRs.
- **API e interface não vêm juntas.** São tasks separadas de propósito; PR que mistura as duas não tem revisão possível.
- **Migration não vem com código de API nem de tela.** É o único tipo de mudança que não dá para desfazer. Duas issues de banco do mesmo tema podem dividir a mesma migration; a rota e a tela que a consomem ficam nos PRs delas.
- **Verificação real.** "Testado" não é verificação; qual comando rodou e o que ele disse, é.

Antes de abrir, com `DATABASE_URL` e `MIGRATION_DATABASE_URL` apontando para um banco seu (as suítes de integração recusam sem elas e recusam o banco `ageniza`; veja [ambiente local](docs/local-environment.md#banco-dos-testes-de-integração)):

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm db:test:local
pnpm --filter @ageniza/api test:integration
pnpm --filter @ageniza/worker test:integration
```

E passe pelo [checklist do implementador](docs/implementation-checklist.md): cada item dele nasceu de um achado real de revisão, e o corpo do PR lista a mutação que prova cada aceite.

## O quadro: onde ver o que dá para pegar

As issues continuam sendo a fonte — elas têm o aceite, as dependências e o esboço da tela. O quadro é a **visão**: [Ageniza — MVP](https://github.com/orgs/Nocrato-Tech/projects/1), também alcançável pela aba **Projects** do repositório.

> O Projects novo só existe no nível de organização; projeto dono por repositório era o Projects clássico, que a GitHub descontinuou. O nosso está **vinculado** ao repositório, que é o que o faz aparecer na aba dele.

Ele existe para responder duas perguntas que uma lista de issues responde mal: **o que dá para fazer em paralelo agora**, e **o que está esperando o quê**.

### As colunas

| coluna | o que significa |
|---|---|
| **Backlog** | reconhecido, sem estar pronto para começar |
| **Refinamento** | o escopo não fechou. Raro aqui, porque task nasce de SPEC aprovada — existe para o caso em que alguém pega uma task e descobre um buraco |
| **Design** | telas **já mergeadas** em `develop`, esperando o refino do designer (label `refino-design`). É a fila dele, visível como coluna. O fluxo do card depois do merge está pendente: ver [`decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md`](docs/business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md) |
| **Design review** | refino entregue, aguardando aprovação |
| **Pronto para dev** | sem bloqueio e sem responsável: **pode ser pego agora** |
| **Em andamento** | alguém se atribuiu |
| **Revisão** | PR aberto, aguardando revisão independente |
| **Pronto para subir** | revisado e mergeado em `develop` |
| **Em produção** | promovido para `main` |

As duas últimas espelham o modelo de branch: `develop` é integração, `main` é produção.

### Os campos, e o que cada um decide

| campo | para que serve |
|---|---|
| **Onda** | a camada de dependência. Onda 1 pode começar hoje; onda 2 depende da 1 ter entrado. **É o campo que diz onde quatro pessoas trabalham sem fila** |
| **Bloqueio** | `dependência` espera outra task, `decisão` espera o dono do produto. Design não entra aqui: tela não espera o designer. Enquanto a fundação do design system não existir no código, toda task de tela fica com `decisão`, e a dependência técnica continua só em **Depende de**: ver [`decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md`](docs/business/decisions/2026-09-28-a-tela-e-implementada-a-partir-do-esboco-e-o-designer.md) |
| **Módulo** | de qual módulo é o trabalho |
| **Escopo** | `db`, `api`, `web`, `infra`, `docs` — qual disciplina pega |
| **Tipo** | épico, history, task, em aberto, débito, bug |
| **Depende de** | os números que a task também cita no corpo |
| **Parent issue** · **Sub-issues progress** | nativos do GitHub: o parentesco real entre épico, history e task |

### O parentesco é nativo, não é convenção

Épico, history e task estão ligados por **sub-issue** do GitHub, não por menção no texto. Então a issue de um épico mostra a árvore com barra de progresso, e o quadro mostra pai e progresso em coluna própria.

Quem criar uma task nova amarra no pai pela própria issue — em "Sub-issues", na history a que ela pertence. Task órfã fica invisível no progresso do épico.

### Regras de uso

- **Onda não é prioridade, é possibilidade.** Uma task de onda 3 não é menos importante; ela só não pode começar antes.
- **Quem pega se atribui** e move para *Em andamento*. É o que impede duas pessoas na mesma coisa, e o que faz *Pronto para dev* dizer a verdade.
- **Quem descobre uma dependência nova atualiza a onda e o campo Depende de.** Dependência que fica só na cabeça de quem descobriu volta a travar o próximo.
- **Épico, history e "em aberto" não têm onda.** Onda é de trabalho executável — filtre por `Tipo:task,bug` para ver só o que se pega.

### Módulo não atropela módulo

A view de **Sequência de módulos** mostra só os épicos, em ordem. A entrevista de um módulo não abre enquanto o anterior não estiver com SPEC aprovada e recortado — é o portão do `AGENTS.md`; o quadro só o torna visível.

## Issue fechada por PR: é automático, mas não pelo GitHub

O GitHub fecha uma issue referenciada apenas quando o PR entra na **branch padrão**, que aqui é `main`. Como todo PR de trabalho vai para `develop`, `Closes #123` **não dispara sozinho** — e sem isso o quadro mostraria como abertas dezenas de tasks já prontas.

O workflow `Close referenced issues` fecha no merge em `develop`. Ele lê o **corpo do pull request** e aceita as duas línguas:

```
Closes #12 · Fixes #12 · Resolves #12
Fecha #12 · Encerra #12
```

Menção solta (`ver #12`) não fecha nada, e referência dentro de bloco de código é ignorada — exemplo em documentação não é intenção. Com o PR agrupado, cada issue precisa da sua própria linha: **um `Closes` por linha** — `Closes #1, #2` fecha só a #1, porque a palavra-chave tem de vir imediatamente antes de cada número. A lógica vive em `scripts/ci/closing-references.mjs`, com teste.

**Issue fechada significa "feito e revisado", não "no ar".** O card continua em *Pronto para subir* até a promoção para `main` movê-lo para *Em produção* — quem quer saber o que já está em produção olha a coluna, não o estado da issue.

Na promoção para `main`, o comando abaixo move de uma vez todos os cards de *Pronto para subir* para *Em produção* — é o único passo do fluxo sem automação, porque o `GITHUB_TOKEN` de um workflow não escreve em projeto de organização:

```sh
pnpm board:released --dry-run   # mostra o que moveria
pnpm board:released
```

Ele exige o `gh` autenticado com o escopo `project` (`gh auth refresh -s project`).

## Revisão

Toda entrega passa por revisão independente antes do merge, **inclusive entrega de agente** — principalmente entrega de agente. Quem escreve o código escreve o teste com os mesmos pontos cegos, e revisões aqui já acharam falhas reais que os testes do próprio autor não pegavam.

O merge exige aprovação e CI verde. A ferramenta não impede o contrário hoje (a organização está no plano Free), então é acordo de time — e um `Branch guard` que abre issue quando alguém contorna.

## Quando o CI reprova

Leia o job que falhou antes de repetir a execução. Um reexecutar cego esconde um defeito real com a mesma facilidade com que contorna um problema de infraestrutura.

- **`Quality gates`** — lint, typecheck, test ou build. Reproduz localmente com os mesmos comandos.
- **`Migration policy`** — você editou, renomeou ou apagou uma migration já aplicada. Corrige-se com uma migration nova; o histórico é sempre para frente.
- **`PostgreSQL local database`** — integração contra o banco real. Se falhar só no CI, desconfie de ordem de execução e de estado deixado por outro teste antes de culpar o ambiente.
- **`Docker images`** — o modelo do Compose não renderiza, ou um serviço local vazou para o modelo de produção.
- **`Branch route`** e **`Branch guard`** — o PR está indo para o lugar errado, ou alguém empurrou direto.

Se a falha não tem relação com a sua mudança, diga isso no PR com a evidência. Não a mergeie em silêncio.

## Mudança estrutural: pare

Altera tabela existente? Muda um formato de resposta que outras rotas copiam? Mexe em RLS de mais de um módulo? Muda como a autorização é avaliada? Exigiria backfill?

Então **pare antes de implementar**, registre a decisão em um arquivo novo em [`docs/business/decisions/`](docs/business/decisions/) dizendo que é estrutural, e só depois escreva. Há um gate de CI que reprova migration estrutural sem decisão registrada — mas ele cobre o banco, e o resto depende de você reconhecer o caso.

## Regra de negócio não se inventa

Se a especificação não cobre o caso, escolha a interpretação mais conservadora e **registre a dúvida** — numa entrada nova em `docs/business/decisions/` ou na issue. Regra inventada em silêncio é a mais cara de descobrir depois, porque parece comportamento.
