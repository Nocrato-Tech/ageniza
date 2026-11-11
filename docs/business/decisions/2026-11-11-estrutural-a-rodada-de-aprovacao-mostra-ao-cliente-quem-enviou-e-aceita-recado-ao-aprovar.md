# ESTRUTURAL: o portal mostra quem enviou a rodada, e o cliente pode aprovar com um recado

**Data.** 2026-11-11

**Contexto.** A decisão [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md) assina o recado com o nome da **agência** e veta de propósito que a data de envio, quem enviou e o lote cheguem ao portal (a migration `20261110000100_content_approval_rounds.mjs` diz que `sent_by` e `batch_id` nunca vão ao portal). O quadro do redesenho (r0) mostra, no post do portal, "Recado de João Pereira, da Agência Horizonte" com avatar e data, e o campo "Seu recado para a agência", opcional, ao aprovar.

**Decisão.**

1. **Remetente visível.** O portal passa a ver, da rodada, o **nome** e a **foto** de quem da agência enviou, e a **data de envio**, ao lado do recado ("Recado de João Pereira, da Agência Horizonte"). Não chegam ao portal o e-mail, o cargo, o papel nem o identificador do colaborador. O lote (`batch_id`) continua sem chegar. Sem recado, o portal mostra só o prazo.
2. **Recado do cliente ao aprovar.** Ao aprovar, a pessoa do portal pode dar um recado à agência, opcional, de até 500 caracteres. O recado **vira um comentário do cliente na conversa do conteúdo**, gravado na mesma transação da aprovação; não há tabela nem coluna de recado nova. Quem aprovou e o que disse ficam registrados.
3. **Pedir ajuste não muda:** continua exigindo comentário.
4. **O link de aprovação do e-mail** continua aprovando sem recado. O recado ao aprovar é do portal.
5. **A conversa continua no post** (ver [`2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post`](2026-11-11-o-inicio-do-portal-segue-o-quadro-e-a-conversa-continua-no-post.md)): o recado aparece nela.

**Substitui.**

- O veto a mostrar o remetente no portal, que a decisão [`2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado`](2026-11-10-estrutural-a-rodada-de-aprovacao-tem-prazo-e-recado.md) herdou do desenho da rodada e que a migration `20261110000100_content_approval_rounds.mjs` registra em comentário: ele deixa de valer, só para o nome, a foto e a data de envio. O e-mail continua assinado pela agência. A migration não é editada.
- A regra de `docs/mobile/fluxos/portal.md` "a data em que foi enviado, quem enviou e o lote ficam com a agência e nunca chegam ao portal": passa a valer só para o lote.

**Consequência.**

- **É estrutural:** muda o que o portal lê (formato do conteúdo do portal, que o link de aprovação e o mobile copiam), muda a função de aprovar no banco (que passa a escrever na conversa do conteúdo) e muda quem enxerga dado pessoal de colaborador.
- **Migration:** a leitura do portal passa a devolver o nome e a foto do remetente por função de leitura de escopo único (o portal não ganha `SELECT` em `content_approval_rounds` nem em membros da agência), e a função de aprovar recebe o recado opcional. Sem backfill: a rodada que não tem remetente gravado (anterior às rodadas) vai sem ele.
- **Risco: Alto.** Portal com autorização, dado pessoal e escrita do cliente. Pede revisão de segurança independente: o portal não lê outra rodada, outro cliente nem o lote; o recado respeita o limite e o estado "aguardando"; aprovar com recado é tudo-ou-nada; agência somente leitura recusa.
- O nome de quem enviou é o do perfil do colaborador, o mesmo que a agência já mostra a si mesma. Quem sair da agência continua aparecendo nas rodadas que enviou, com o nome que tinha.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de mostrar o remetente e aceitar recado ao aprovar (riscos 15 e 16 do inventário do redesenho).

**Validação.** Pendente de validação do dono.
