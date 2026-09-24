# Como contribuir

Este documento cobre o fluxo de trabalho: branch, commit, PR, revisão. O que **pode** ser construído, e quando, está em [Como um módulo é fechado](docs/business/module-process.md). Os invariantes que ninguém contraria estão em [`AGENTS.md`](AGENTS.md).

## Antes de escrever a primeira linha

1. [`docs/onboarding.md`](docs/onboarding.md) — o roteiro de leitura.
2. [`AGENTS.md`](AGENTS.md) — invariantes. Curto, e vale para pessoas e agentes.
3. [`docs/business/structural-changes.md`](docs/business/structural-changes.md) — obrigatório antes de implementar qualquer coisa nova.

## O portão: nada se implementa sem SPEC

Módulo novo **não começa** por código. Ele passa por entrevista, vira uma SPEC em `specs/`, e só então é recortado em issues. Se você pegou uma task e não encontra a SPEC dela, pare e pergunte: ou a SPEC existe e você não achou, ou a task nasceu fora do processo.

Uma **task** de implementação já chega com aceite verificável e a seção da SPEC que a define. Se ela não tiver isso, ela não está pronta para ser pega.

Task marcada **`aguardando-design`** espera a entrega do designer. Ela já traz o esboço da tela no corpo — é o briefing dele, não a sua especificação para inventar o layout.

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

- **Um PR, um assunto.** Se o título precisa de "e", provavelmente são dois PRs.
- **API e interface não vêm juntas.** São tasks separadas de propósito; PR que mistura as duas não tem revisão possível.
- **Migration vem sozinha.** É o único tipo de mudança que não dá para desfazer.
- **Verificação real.** "Testado" não é verificação; qual comando rodou e o que ele disse, é.

Antes de abrir:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm db:test:local
pnpm --filter @ageniza/api test:integration
pnpm --filter @ageniza/worker test:integration
```

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

Então **pare antes de implementar**, registre a decisão em [`decisions.md`](docs/business/decisions.md) dizendo que é estrutural, e só depois escreva. Há um gate de CI que reprova migration estrutural sem decisão registrada — mas ele cobre o banco, e o resto depende de você reconhecer o caso.

## Regra de negócio não se inventa

Se a especificação não cobre o caso, escolha a interpretação mais conservadora e **registre a dúvida** — em `decisions.md` ou na issue. Regra inventada em silêncio é a mais cara de descobrir depois, porque parece comportamento.
