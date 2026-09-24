# Como um módulo é fechado

Nenhum módulo novo começa a ser implementado antes de passar por aqui. O processo tem quatro fases, e cada uma produz um artefato diferente — não é burocracia empilhada: cada artefato responde a uma pergunta que as outras não respondem.

| fase | artefato | responde |
|---|---|---|
| 1. Entrevista | entradas em [decisions.md](decisions.md) | **por que assim**, e qual alternativa foi fechada |
| 2. SPEC | `specs/<modulo>.md` | **como fica** — back, front e UX |
| 3. Recorte | issues no GitHub | **o que vai ser feito**, por quem, em que ordem |
| 4. Fechamento | PR + atualização da SPEC | **o que realmente ficou** |

A SPEC é o documento final da conversa. É dela que sai todo o resto: as *histories*, as *tasks* e os débitos.

## Fase 1 — Entrevista

Uma sessão de questionamento por módulo, conduzida por agente ou pessoa. O papel de quem conduz é **perguntar, propor e registrar** — nunca decidir. Quando a resposta não existe ainda, o ponto vai para "Em aberto"; não vira palpite escrito com cara de fato.

A sessão abre com uma **pergunta aberta sobre o fluxo**, antes de qualquer rodada: como o módulo deve funcionar na prática e quais telas quem usa imagina. Não é desenho e não é decisão — é intenção e inventário, que os blocos seguintes refinam contra os contratos e as regras que já existem. Ela existe porque UX é o sétimo assunto: sem a abertura, uma capacidade que o backend não tem só aparece no fim, depois de a sessão ter decidido tudo em cima do que já existia.

Depois dela, a sessão é conduzida pelo método da skill `grilling`: a conversa é uma árvore de decisão trabalhada em rodadas, cada rodada perguntando toda a fronteira de uma vez — as decisões cujos pré-requisitos já estão resolvidos —, numeradas e com recomendação. Quem responde decide; quem pergunta busca os fatos sozinho.

Os sete blocos são a ordem da árvore, que é a ordem do custo de errar:

1. **Propósito** — o que o módulo resolve e o que ele explicitamente **não** resolve.
2. **Atores e autorização** — quem faz o quê, em permissões nomeadas.
3. **Entidades e campos** — o que é invariante do domínio, não campo de formulário.
4. **Estados e transições** — quais mudanças de estado são legítimas, e o que cada uma exige.
5. **Regras invioláveis** — o que nunca pode acontecer. É daqui que saem os testes.
6. **UX** — quais telas existem, o que cada uma mostra, o que muda conforme o papel de quem olha, e como ficam o estado vazio, o de carregamento e o de erro.
7. **Impacto estrutural** — o que isso arrasta.

**O bloco de UX é o briefing do designer.** Ele não produz a tela: produz o esboço em nível de wireframe — que telas existem, o que cada uma mostra, o que muda por papel — que é entregue ao designer, e é dele que a tela real volta. A sequência é sempre esboço → design → código.

**UX vem no fim, de propósito.** Tela desenhada antes de estado definido inventa estado. E o bloco de UX é esboço: quais telas, com o quê, para quem. Cor, tipografia e espaçamento são trabalho do designer e não entram na sessão — discuti-los ali transforma a entrevista em reunião de design e o módulo não fecha.

**Mudança estrutural para a sessão.** Se o bloco 7 acusar uma das condições de [structural-changes.md](structural-changes.md), a decisão é registrada antes de qualquer implementação, dizendo explicitamente que é estrutural.

**Decisão fechada é registrada na hora**, não no fim do módulo — em [decisions.md](decisions.md), marcada como *pendente de validação* enquanto ninguém tiver validado. Registrar a decisão provisória e marcá-la é melhor do que esperar a aprovação e perder o contexto de por que a alternativa foi descartada.

## Fase 2 — SPEC

Consolida a entrevista em `specs/<modulo>.md`, a partir de [`specs/TEMPLATE.md`](../../specs/TEMPLATE.md).

Back e front ficam **no mesmo documento**, porque a coerência entre os dois é justamente o que o processo existe para garantir. A implementação é que se separa, na fase seguinte.

### O que "fechar o módulo" significa

Não é dúvida zerada — é ter passado por todas as frentes que sustentam aquele módulo: backend, frontend, infraestrutura quando houver, e autorização. Todo módulo termina com pontos em aberto, e isso é saudável.

O que não é aceitável é ponto em aberto sem **gatilho**: o evento que obriga a decisão. Não uma data — um evento. "Decidir quando o portal do cliente existir", "decidir antes da primeira listagem que passar de uma página". Item em aberto com gatilho é agenda; sem gatilho é dívida invisível.

## Fase 3 — Recorte em issues

A SPEC vira uma **history** por capacidade entregável, e **tasks** dentro dela.

- A *history* descreve o resultado do ponto de vista de quem usa, e aponta para a seção da SPEC que a define.
- As *tasks* são o trabalho: uma por frente (`escopo:api`, `escopo:web`, `escopo:db`, `escopo:infra`). Task que atravessa duas frentes vira duas tasks — PR que mistura API e interface não tem revisão possível.
- **Task de `escopo:web` nasce pronta, mas bloqueada.** Ela é escrita a partir do esboço e das decisões da SPEC, e recebe `aguardando-design` até o designer entregar a tela. A API não espera por isso: `escopo:api` e `escopo:db` seguem em paralelo.
- **O esboço vai dentro da task, não só linkado.** Wireframe, o que cada elemento faz e os estados a cobrir. Quem vai desenhar a tela precisa ler uma issue, não caçar a seção certa de uma SPEC longa.
- O que ficou em aberto com gatilho vira issue `em-aberto`, não comentário solto.
- O que ficou como dívida reconhecida vira issue `debito`.

Labels em uso:

| label | para quê |
|---|---|
| `tipo:history` | capacidade entregável, agrupa tasks |
| `tipo:task` | uma unidade de trabalho, uma frente |
| `tipo:spec` | a sessão de entrevista/consolidação do módulo |
| `escopo:api` `escopo:web` `escopo:db` `escopo:infra` | onde o trabalho acontece |
| `modulo:<nome>` | a que módulo pertence |
| `aguardando-design` | task de interface escrita e bloqueada até a tela ser entregue |
| `estrutural` | exige decisão registrada antes de implementar |
| `em-aberto` | ponto não decidido, com gatilho no corpo |
| `debito` | dívida reconhecida e aceita conscientemente |

## O portão entre módulos

**A entrevista de um módulo não abre enquanto o anterior não estiver fechado e recortado.** Fechado é a SPEC aprovada; recortado é a *history*, as *tasks*, os abertos e os débitos criados no GitHub, com a seção 12 da SPEC preenchida com os números.

Uma precisão que o primeiro módulo já exigiu: **"recortado" não quer dizer "tem pelo menos uma history"**. A SPEC de autorização e transversais tem zero, porque convenção não é capacidade entregável. O portão é o recorte existir, não a contagem.

## Fase 4 — Fechamento

O PR implementa a task. Quando a implementação divergir da SPEC — e vai divergir — **a SPEC é corrigida no mesmo PR**. Duas fontes de verdade divergentes são piores do que uma fonte desatualizada admitida.

Antes do handoff, rodar lint, typecheck, testes e build, como manda o [`AGENTS.md`](../../AGENTS.md).

## Quem aprova

As decisões de produto são do dono do produto. Agente e dev propõem, questionam e registram; nada vira decisão porque pareceu coerente para quem estava implementando.

## No harness

Três comandos, um por fase:

- `/modulo-entrevista <nome>` — conduz a sessão, bloco a bloco, e registra as decisões conforme elas fecham.
- `/modulo-spec <nome>` — consolida a sessão na SPEC.
- `/modulo-issues <nome>` — deriva a history, as tasks, os abertos e os débitos a partir da SPEC.
