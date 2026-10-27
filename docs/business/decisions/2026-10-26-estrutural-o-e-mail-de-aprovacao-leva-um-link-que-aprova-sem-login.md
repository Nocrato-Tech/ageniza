# ESTRUTURAL: o e-mail de "conteúdos para aprovar" leva um link que aprova sem login

**Data.** 2026-10-26

**Contexto.** O e-mail "conteúdos para aprovar" sai da fila de notificação do worker, agrupado com espera de 15 minutos, para as pessoas ativas do portal (`specs/conteudo.md`). Até aqui ele levava ao portal, que pede login.

**Decisão.** O dono decidiu que **cada e-mail de aprovação carrega um link próprio**, que abre **só os conteúdos daquele lote**, com a prévia de celular, Aprovar e Pedir ajuste.

1. Um link por pessoa e por lote. Ele vale **7 dias** e não pede login nem conta.
2. O link é **revogado na hora** quando a pessoa perde o acesso ao portal, quando o cliente é arquivado, quando a agência é suspensa e quando a agência fica somente leitura no fim do trial.
3. A decisão é registrada **como aquela pessoa**, com o mesmo efeito da aprovação pelo portal: uma pessoa basta, o pedido de ajuste exige comentário e o comentário entra na conversa do conteúdo. A agência vê que a aprovação veio pelo link do e-mail.
4. Cada conteúdo do lote só aceita decisão enquanto está **aguardando aprovação**. O que já foi decidido, por esta ou por outra pessoa, aparece com o estado atual e sem botões. O que mudou e voltou a aguardar aprovação continua no link enquanto ele valer.
5. Abrir o link não decide nada: Aprovar e Pedir ajuste exigem um clique. Um leitor de e-mail que abre o link não aprova nada. O token sai da barra de endereço ao abrir, como em `/email/confirmar`.
6. O link não abre mais nada do portal: nem a marca, nem a conversa geral, nem outros conteúdos. No fim, a tela oferece "Criar conta para ver o portal", que leva ao cadastro já com aquele e-mail e vincula o acesso quando o e-mail for confirmado (decisão do mesmo dia sobre o acesso ao portal).
7. O banco guarda só o hash do token, como no convite. Limites de tentativa por IP valem na rota pública.

**Consequência.** Estrutural: uma tabela nova de links de aprovação, com RLS, e funções `security definer` de escopo único para ler o lote e decidir por hash do token, sem sessão. É um segundo ator na transição "aguardando aprovação → aprovado ou em ajuste", ao lado da pessoa logada no portal. A fila de notificação passa a gerar um link por destinatário. Quem tem o e-mail na mão aprova: o risco aceito é o mesmo do e-mail da pessoa, e o link não dá acesso a nada além do lote. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26 ("O lote do e-mail"). Os itens 1 e 2 e a ideia geral são do dono. Os itens 3 a 7 foram derivados pelo maestro e estão **pendentes de validação pelo dono do produto**.
