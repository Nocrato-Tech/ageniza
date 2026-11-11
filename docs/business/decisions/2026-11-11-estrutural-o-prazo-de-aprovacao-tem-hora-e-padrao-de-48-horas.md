# ESTRUTURAL: o prazo de aprovação passa a ter hora, com padrão de 48 horas

**Data.** 2026-11-11

**Contexto.** A decisão [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md) deu à rodada um prazo opcional, **um dia** de São Paulo (`due_on`, tipo `date`). O quadro do redesenho (r0) mostra "Responder até quinta, 12 nov, 18h", o campo "Responder até" com data **e hora** e a dica "Padrão: 48 horas" no envio, e "Falta 1 dia" no portal.

**Decisão.**

1. **O prazo é um instante.** O prazo de aprovação passa a ser uma data e uma hora, no fuso de São Paulo. Vai de **agora até 90 dias** à frente.
2. **Padrão de 48 horas.** O diálogo de envio propõe o prazo de **48 horas depois do envio**, que a agência pode mudar (data e hora) ou limpar. O padrão é da tela: a API continua aceitando o envio sem prazo, e a rodada sem prazo continua existindo, como o conteúdo que já aguardava antes das rodadas.
3. **O recado não muda**: opcional, até 500 caracteres.
4. **O que já tem prazo mantém o sentido.** O prazo gravado como dia vale até o **fim desse dia** em São Paulo (23h59), que é o que o dia significava.
5. **Lembretes.** Os dois lembretes ("vence amanhã" e "venceu") seguem a regra de [`2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu`](2026-11-10-estrutural-lembretes-de-aprovacao-vence-amanha-e-venceu.md), contados pelo **dia** de São Paulo do prazo e enviados às 9h, uma vez por rodada cada. A hora do prazo não cria lembrete novo. No Início da agência e no portal, o estado do prazo usa a hora: "vence hoje às 18h", "vence em 2 dias", "venceu há 1 dia".
6. **Notificação no app.** Passado o instante do prazo sem decisão, a agência recebe a notificação "venceu o prazo" (ver [`2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos`](2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md)).

**Substitui.**

- O item 1 de [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md) no trecho "o prazo vai de hoje até 90 dias à frente, no dia de São Paulo" e "opcional" como regra da tela (continua opcional na API).
- O item 2 de [`2026-11-10-parado-no-cliente-no-inicio-da-agencia`](2026-11-10-parado-no-cliente-no-inicio-da-agencia.md) no trecho que conta o estado do prazo só em dias: passa a poder dizer "vence hoje às 18h".

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`content_approval_rounds`), muda o formato do prazo que o conteúdo, o portal e o Início copiam, e precisa de backfill.
- **Migration** nova (forward-only): coluna `due_at` (timestamptz, anulável) em `content_approval_rounds`; **backfill** das linhas que têm `due_on` para o fim desse dia em São Paulo; `due_on` continua como o dia de São Paulo de `due_at`, gravado pela função de envio, para o trabalho dos lembretes e as leituras que existem continuarem valendo. A função de envio passa a receber o instante e a recusar fora de "agora até 90 dias".
- **Risco: Alto.** Banco e RLS da rodada, formato lido pelo portal e pelo link de aprovação, e uma regra de tempo (fuso de São Paulo, fim do dia no backfill). Pede revisão de segurança independente e mutação para: recusa fora da janela, backfill do fim do dia, dia do lembrete e portal sem dado interno.
- Os contratos do conteúdo, do portal e do `awaiting-client` trocam `dueOn` por `dueAt` (mantendo `dueOn` na transição, até a web e o mobile migrarem).
- O fluxo mobile da agência e o do portal descrevem o prazo com hora.

**Origem.** Pedido do dono do produto em 2026-11-11 ("quero exatamente tudo igual ao proposto no quadro; se precisar mexer no backend, sem problemas") e decisão do maestro de que o prazo tem hora e padrão de 48 horas.

**Validação.** Pendente de validação do dono.
