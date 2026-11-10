# O cartão de conteúdo fica enxuto, e fechar um formulário com dado digitado pede confirmação

**Data.** 2026-11-10

**Contexto.** O cartão do calendário mostra mais do que cabe sem poluir a tela (decisão [`2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga`](2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga.md), item 3). Separadamente, fechar um formulário por engano perde o que foi digitado.

**Decisão.**

1. **Cartão enxuto.** O cartão do calendário e o das listas mostra **título, uma linha de apoio e o estado**. O resto vai para o cartão de passar o mouse.
2. **Fechamento seguro.** Fechar um formulário com dado digitado (Esc, clique fora ou X) **pede confirmação**. Formulário vazio fecha direto.

**Substitui, em parte.** O item 3 de [`2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga`](2026-11-04-calendario-editorial-tem-mes-semana-e-feed-card-sem-capa-e-celular-so-na-tela-larga.md), na lista do que o cartão mostra (formato, data e hora, alerta de prazo ou atraso e percentual das subtarefas): isso passa a ser título, uma linha de apoio e o estado. O resto do item 3 segue valendo: o cartão não tem capa, um toque abre o conteúdo, arrastar não abre e o dia cheio mostra o resumo **+N**.

**Consequência.**

- Só a tela muda: nenhuma rota, tabela ou permissão. O componente de diálogo passa a ter a confirmação de descarte, que o modal de conteúdo já tem.

**Origem.** Pedido do dono do produto em 2026-11-10, depois da pesquisa da Orkestrya e do Refcat (2026-11-09).

**Validação.** Pendente de validação do dono.
