# ESTRUTURAL: o e-mail de "conteúdos para aprovar" leva um link que aprova sem login

**Data.** 2026-10-26

**Contexto.** O e-mail "conteúdos para aprovar" sai da fila de notificação do worker, agrupado com espera de 15 minutos, para as pessoas ativas do portal (`specs/conteudo.md`). Até aqui ele levava ao portal, que pede login.

**Decisão.** O dono decidiu que **cada e-mail de aprovação carrega um link próprio**, que abre **só os conteúdos daquele lote**, com a prévia de celular, Aprovar e Pedir ajuste.

1. Um link por acesso ao portal e por lote. Ele vale **7 dias** e não pede login nem conta.
2. **A revogação é conferida a cada uso**, não disparada por um evento, porque o fim do trial é uma data que passa e não um evento. Em toda leitura do lote e em toda decisão, a função confere: o link não venceu nem foi revogado, o acesso está ativo, o cliente não está arquivado, a agência não está suspensa e a agência aceita escrita (o trial não venceu). **O link guarda a geração do acesso** em que foi emitido. Remover o acesso avança a geração, por qualquer caminho de remoção, porque todos passam pela função do acesso (decisão do mesmo dia sobre o acesso ao portal, Consequência). Um link de geração antiga fica morto para sempre: **reativar o acesso, ou adicionar de novo o mesmo e-mail, não ressuscita um link antigo**.
3. A decisão é registrada **como aquele acesso**, com o mesmo efeito da aprovação pelo portal: uma pessoa basta, o pedido de ajuste exige comentário e o comentário entra na conversa do conteúdo. A autoria é gravada nas colunas que apontam para o acesso (decisão do mesmo dia sobre o acesso ao portal, Consequência), e é por elas que a agência vê que a aprovação veio pelo link do e-mail.
4. Cada conteúdo do lote só aceita decisão enquanto está **aguardando aprovação**. O que já foi decidido, por esta ou por outra pessoa, aparece com o estado atual e sem botões. O que mudou e voltou a aguardar aprovação continua no link enquanto ele valer.
5. Abrir o link não decide nada: Aprovar e Pedir ajuste exigem um clique. Um leitor de e-mail que abre o link não aprova nada.
6. **O token vai no fragmento** (`#`) do link, que o navegador não envia ao servidor nem aos logs do proxy. A tela lê o fragmento, apaga-o da barra de endereço e o **troca por um cookie de sessão de aprovação** (`HttpOnly`, `Secure`, `SameSite=Strict`, restrito às rotas do link, com validade curta e nunca além da do link). Esse cookie só alcança aquele lote, não é uma sessão de conta, e cada uso dele passa pelas conferências do item 2.
7. As respostas do lote saem com `Cache-Control: no-store`. As mídias da prévia vêm por **URL assinada de validade curta**, de minutos, e nunca pelos 7 dias do link.
8. O link não abre mais nada do portal: nem a marca, nem a conversa geral, nem outros conteúdos. No fim, a tela oferece "Criar conta para ver o portal", que leva ao cadastro já com aquele e-mail. O acesso passa à conta quando ela entrar com o e-mail verificado (decisão do mesmo dia sobre o acesso ao portal, item 3).
9. O banco guarda só o hash do token e o hash do cookie, como no convite. Limites de tentativa por IP valem nas rotas públicas.

**Consequência.** Estrutural, e **não é só uma tabela nova**:

- uma tabela nova de links de aprovação (o acesso, o lote, o hash do token, a geração do acesso, a validade e a revogação) e das sessões de aprovação que o item 6 cria, com RLS;
- funções `security definer` de escopo único para trocar o token pelo cookie, ler o lote e decidir, sem sessão de conta. A de decidir põe o acesso no contexto **local da transação** (`set_config(..., true)`), e o trigger de transição e a escrita de comentário só aceitam essa variável quando a escrita vem dela;
- o link é um segundo ator na transição "aguardando aprovação → aprovado ou em ajuste", ao lado da pessoa logada no portal. Isso altera o trigger de transição de `contents`, `contents.approved_by`, `client_thread_comments.author_user_id` e `notification_queue.recipient_user_id`, com as colunas de acesso e os checks descritos na decisão sobre o acesso ao portal (no máximo um dos dois em `contents`, exatamente um em `client_thread_comments`, com o acesso só no lado do cliente);
- a fila de notificação passa a ter **o acesso como destinatário** de toda pessoa do portal, com a janela de 15 minutos por acesso, e gera um link por acesso e por lote.

Quem tem o e-mail na mão aprova: o risco aceito é o mesmo do e-mail da pessoa, e o link não dá acesso a nada além do lote. Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26 ("O lote do e-mail"). Os itens 1 e 2 e a ideia geral são do dono. A conferência a cada uso e a geração (item 2), e os itens 3 a 9, foram derivados pelo maestro, a conferência, a geração, o fragmento, o cookie, o `no-store` e a URL assinada curta a partir da revisão do PR #720.

**Validação.** Validada pelo dono em 2026-10-27.
