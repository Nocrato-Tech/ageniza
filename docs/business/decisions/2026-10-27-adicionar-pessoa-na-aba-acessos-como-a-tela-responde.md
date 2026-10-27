# Adicionar pessoa na aba Acessos: o modal fecha no sucesso, o erro mantém o e-mail, e o convite antigo só se cancela

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 (acesso ao portal por e-mail) troca "Convidar" por "Adicionar pessoa", e as decisões de 2026-10-27 do #711 definem o que a API responde (201, 409 `ACCESS_EXISTS`, 502 `EMAIL_DELIVERY_FAILED` com o acesso mantido, e o reenvio de convite de portal recusado). Faltava dizer o que a tela faz com cada resposta, e o que sobra da seção de convites antigos.

**Decisão.**

1. O modal tem só o campo de e-mail e o botão **Adicionar**. No sucesso ele **fecha** e a aba mostra a frase "<e-mail> agora tem acesso ao portal deste cliente.", escrita com o e-mail digitado: a frase é a mesma qualquer que seja a resposta sobre a conta, porque a tela nunca diz se o e-mail tem conta.
2. Em qualquer erro o modal **continua aberto com o e-mail digitado**. 409 `ACCESS_EXISTS` aparece no campo; 409 `CLIENT_ARCHIVED`, 403, 429 `DAILY_EMAIL_LIMIT` e 400 aparecem como mensagem do formulário; 502 `EMAIL_DELIVERY_FAILED` diz que o acesso foi dado e que o e-mail não foi entregue, e que para mandar de novo a agência remove o acesso e adiciona o e-mail outra vez (decisão de 2026-10-27, "o e-mail que falha não desfaz o acesso"). A lista é relida depois de qualquer resposta, porque o 502 deixa o acesso criado.
3. A lista mostra o nome da conta quando a pessoa já entrou e **"ainda não entrou"** quando o acesso não tem conta, com o e-mail na linha de baixo nos dois casos. Remover e Reativar usam o id do acesso.
4. **Reenviar sai da seção de convites aguardando aceite.** A API recusa o reenvio de convite de portal (409 `PORTAL_INVITATION_DISCONTINUED`), então o botão só levaria a um erro. Cada convite antigo mostra a validade e **Cancelar**; a seção some quando o último vence ou é cancelado. A confirmação de cancelar manda a agência para "Adicionar pessoa" em vez de "convidar a pessoa outra vez".
5. Em agência somente leitura, **Adicionar pessoa** e **Reativar** ficam desabilitados com o motivo; **Remover** e **Cancelar** (convite antigo) continuam habilitados, porque reduzem acesso (decisão de 2026-10-27, "o que o somente leitura deixa").
6. Uma permissão por ação: `cliente.convidar_usuario` abre a aba e adiciona; `cliente.remover_usuario` remove e reativa; `convite.cancelar` cancela convite antigo.

**Consequência.** Só a aba Acessos do detalhe do cliente muda; nenhuma tabela, rota ou permissão nova. A `specs/clientes.md` (aba Acessos) passa a descrever o desenho acima. O e-mail do limite diário (429) é tratado na tela desde já; a rota passa a respondê-lo quando o `TODO(#725)` dela for resolvido.

**Origem.** Issue #716 (épico #718), a partir das decisões de 2026-10-26 e 2026-10-27 do #711. O texto de cada mensagem e a retirada do Reenviar são da implementação.

**Validação.** Pendente de validação do dono.
