# ESTRUTURAL: o link do convite de colaborador pode ser copiado logo depois do envio

**Data.** 2026-10-26

**Contexto.** O convite chega só por e-mail, e o banco guarda apenas o hash do token: nem a operação recupera o link depois de enviado. O dono do produto quer poder mandar o link direto à pessoa, por WhatsApp por exemplo, sem ela precisar abrir o e-mail.

**Decisão.** O dono decidiu que, no modal "Convidar colaborador", depois de **Enviar**, o modal mostra o botão **Copiar link**. É o **mesmo** link que foi ao e-mail: de uso único, preso ao e-mail e ao papel do convite, e válido por 7 dias. Não existe link reutilizável nem link sem e-mail.

1. A resposta da criação do convite traz o link **uma vez**. Só o modal que acabou de enviar o mostra. Fechado o modal, o link não volta: para mandar de novo, reenvie, o que gera um link novo e invalida o anterior. O banco continua guardando só o hash.
2. Copiar o link quebra a premissa de que o token só existe na caixa do destinatário: quem convidou também o tem. Por isso **a conta criada pelo aceite de um convite nasce com o e-mail não confirmado**, qualquer que seja o caminho pelo qual o link chegou. Um e-mail de confirmação vai junto. O acesso ao contexto do convite vale na hora, como hoje, porque foi a agência que o deu. Enquanto o e-mail não é confirmado, a conta não cria agência, e o login com o Google no mesmo e-mail assume a conta (decisão do mesmo dia sobre o Google).
3. A resposta que traz o link nunca é registrada em log, e o link nunca aparece em lista, cache de listagem ou URL da tela.

**Consequência.** Muda o contrato de uma rota implantada (`POST /agencies/:agencyId/invitations/collaborators` passa a devolver o link) e muda o aceite com conta nova (`accept-new-account` deixa de marcar o e-mail como verificado). Por isso é estrutural: muda como a verificação de e-mail é estabelecida. Não muda tabela nem exige backfill. A regra 6 de `specs/auth.md` não muda: o e-mail da conta continua sendo o do convite. O convite de portal fica de fora desta decisão, porque o acesso ao portal passa a ser por e-mail (decisão do mesmo dia). Pede revisão de segurança independente.

**Origem.** Pedido do dono do produto em sessão, 2026-10-26: "desbloqueia o botão de 'copiar link' que é o mesmo que vai para o email". O item 1 é do dono. Os itens 2 e 3 foram derivados pelo maestro e estão **pendentes de validação pelo dono do produto**.
