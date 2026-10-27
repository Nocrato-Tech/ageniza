# ESTRUTURAL: o link do convite de colaborador pode ser copiado logo depois do envio

**Data.** 2026-10-26

**Contexto.** O convite chega só por e-mail, e o banco guarda apenas o hash do token: nem a operação recupera o link depois de enviado. O dono do produto quer poder mandar o link direto à pessoa, por WhatsApp por exemplo, sem ela precisar abrir o e-mail.

**Decisão.** O dono decidiu que, no modal "Convidar colaborador", depois de **Enviar**, o modal mostra o botão **Copiar link**. É o **mesmo** link que foi ao e-mail: de uso único, preso ao e-mail e ao papel do convite, e válido por 7 dias. Não existe link reutilizável nem link sem e-mail.

1. A resposta da criação do convite traz o link **uma vez**. O **reenvio** também devolve o link novo, uma vez, e invalida o anterior. Só a tela que acabou de enviar ou reenviar o mostra. Fechada a tela, o link não volta: para mandar de novo, reenvie. O banco continua guardando só o hash. Criar e reenviar contam no limite diário de e-mails da agência (decisão do mesmo dia sobre o trial, item 8).
2. Copiar o link quebra a premissa de que o token só existe na caixa do destinatário: quem convidou também o tem. Por isso **a conta criada pelo aceite de um convite nasce com o e-mail não confirmado**, qualquer que seja o caminho pelo qual o link chegou, e um e-mail de confirmação vai junto. **Essa conta é a exceção explícita** à regra do cadastro de que sem confirmar não há sessão (decisão do mesmo dia sobre o cadastro, item 2): o acesso ao contexto do convite vale na hora, como hoje, porque foi a agência que o deu.
   - O login com senha dessa conta entra nos contextos que ela tem e mostra o aviso "confirme o seu e-mail", com reenvio. Se ela não tiver mais contexto nenhum, vale o cadastro: o login diz "confirme o seu e-mail" e não cria sessão.
   - Confirmar segue a regra do cadastro: `/email/verificar` pede o token e a senha da conta (item 3 da mesma decisão).
   - Enquanto o e-mail não é confirmado, a conta não cria agência e não ganha acesso ao portal por e-mail. O dono do e-mail assume a conta pelo Google ou por "Esqueci a senha" (decisões do mesmo dia sobre o Google, item 4, e sobre o cadastro, item 5).
3. As respostas que trazem o link saem com `Cache-Control: no-store` e nunca são registradas em log. O link nunca aparece em lista, cache de listagem ou URL da tela.

**Consequência.** Muda o contrato de duas rotas implantadas: `POST /agencies/:agencyId/invitations/collaborators` e o reenvio do convite passam a devolver o link. Muda também o aceite com conta nova: `accept-new-account` deixa de marcar o e-mail como verificado. Por isso é estrutural: muda como a verificação de e-mail é estabelecida e abre uma exceção à regra de sessão. Não muda tabela nem exige backfill. A regra 6 de `specs/auth.md` não muda: o e-mail da conta continua sendo o do convite. O convite de portal fica de fora desta decisão, porque o acesso ao portal passa a ser por e-mail (decisão do mesmo dia). Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26: "desbloqueia o botão de 'copiar link' que é o mesmo que vai para o email". O botão e o link igual ao do e-mail são do dono. O link no reenvio e o limite diário (item 1), o item 2 e o item 3 foram derivados pelo maestro, alguns a partir da revisão do PR #720.

**Validação.** Pendente de validação do dono.
