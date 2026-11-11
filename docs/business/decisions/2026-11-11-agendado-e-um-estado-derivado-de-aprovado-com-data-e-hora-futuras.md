# "Agendado" é um estado derivado de aprovado com data e hora de publicação futuras, e a agência volta a dizer "Aprovado"

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) mostra o estado **Agendado** (chip do calendário, etiqueta, bloco "Agendados" do Início, "Aprovado e agendado" na aba Conteúdos do cliente) e o texto "saem sozinhos até dia 20". A decisão [`2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir`](2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir.md) deixou a publicação pela plataforma fora do MVP: no MVP a agência publica por fora e marca como publicado. O conteúdo já guarda a hora de publicação (`publish_at_time`, opcional), o que permite derivar o estado sem tabela nem coluna nova.

**Decisão.**

1. **Agendado é derivado.** Um conteúdo está **agendado** quando está aprovado (`approved`), tem **hora de publicação** e o instante `publishOn` + `publishAtTime`, no fuso de São Paulo, ainda não passou. Não há estado novo no enum nem coluna: é calculado, como "atrasado" e "prazo em dois dias".
2. **Sem hora, continua aprovado.** O aprovado sem hora de publicação é só **Aprovado**, ainda que a data seja futura. Passado o instante, o conteúdo volta a ser Aprovado até a agência marcar como publicado. Nenhuma mudança de dado acontece quando o instante passa.
3. **Não há publicação automática.** A Meta continua fora do MVP. O texto da tela diz "programados até dia N" (a data do último agendado), nunca "saem sozinhos". "Agendar os aprovados" é abrir os aprovados sem hora para dar a hora.
4. **A agência diz "Aprovado".** O estado `approved` deixa de se chamar "Pronto para publicar" na agência e passa a se chamar **Aprovado**, como já se chama no portal. O verbo "pronto" some da interface.
5. **Chips do calendário.** Todos, Em produção, Aguardando, Aprovado, Agendado, Atrasado e Publicado, com a contagem. "Em ajuste" conta dentro de "Em produção" (nos dois a vez é da agência), e a etiqueta de cada card continua dizendo "Em ajuste". Aprovado e Agendado são exclusivos entre si; Atrasado atravessa os outros (ver [`2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio`](2026-11-11-atrasado-conta-pela-data-de-publicacao-e-parado-no-cliente-segue-a-ordem-de-envio.md)).
6. **O portal não usa a palavra Agendado.** Mostra "Aprovado" com a data e a hora ("publica na sexta, 13 nov, às 12h").

**Substitui.**

- O trecho "Na agência, 'aprovado' aparece como **pronto para publicar**" de `specs/conteudo.md` (seção 4), e os rótulos de `apps/web/src/content-labels.ts` que dizem "Pronto para publicar".
- O trecho "Pronto para publicar" da tabela de estados de [`2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes`](2026-10-13-pauta-quem-tem-a-vez-decide-a-cor-e-as-quatro-excecoes.md) (item 1) e de `docs/design-system.md` 25.1: o estado e a cor (`teal`) são os mesmos, muda o nome.
- Nada em [`2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir`](2026-09-26-integracao-com-a-meta-fica-fora-do-mvp-e-publicar-e-medir.md): esta decisão a respeita.

**Consequência.**

- Não é estrutural: nenhuma tabela, coluna ou policy muda. A hora de publicação já existe e já chega ao portal (`publishAtTime`). Os contratos de conteúdo ganham o derivado `scheduled` na lista, como já têm o de atraso.
- O `StatusTag` ganha o estado `scheduled` (o token `status-scheduled` já existe).
- Quem decidir publicar pela plataforma (gatilho da #149) transforma o derivado em ação e revê esta decisão.

**Origem.** Pedido do dono do produto em 2026-11-11 ("quero exatamente tudo igual ao proposto no quadro") e resposta dele de que Agendado é um conteúdo aprovado com data e hora de publicação futuras, sem publicação automática.

**Validação.** Pendente de validação do dono.
