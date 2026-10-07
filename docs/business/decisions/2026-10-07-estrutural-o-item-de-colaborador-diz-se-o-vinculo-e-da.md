# ESTRUTURAL: o item de colaborador diz se o vínculo é da própria pessoa (`isSelf`)
**Data.** 2026-10-07

**Esta é uma mudança estrutural**, por um dos cinco critérios de [structural-changes.md](structural-changes.md): muda o **formato de resposta** que outras rotas já usam. O `CollaboratorSchema` é o item da listagem, do detalhe, do `PATCH`, de remover e de reativar, e a listagem é a referência que as próximas copiam. Registrada antes da implementação, no mesmo PR, a pedido do maestro (issue #286).

**Contexto.** A tela do modal do colaborador (#108) decide se a pessoa está vendo o próprio vínculo (e então edita nome e foto) comparando o e-mail canônico da sessão com o e-mail do vínculo, porque o contrato não traz o `userId`. Não é risco de segurança (`PATCH /me/profile` e `POST /me/photo` agem sempre no usuário da sessão), mas a operação pode trocar o e-mail, e aí o modal fica sem edição até a sessão ser relida.

**Decisão.** O item de colaborador ganha `isSelf: boolean`, obrigatório, em **todas** as respostas que usam o `CollaboratorSchema`, calculado no servidor: o `user_id` do vínculo é igual ao usuário da sessão (`app_private.current_user_id()`, o ator gravado pelo banco na transação). O `userId` **não** entra na resposta: ele é de outras pessoas, e `isSelf` diz só o que a tela precisa. Um único formato, sem variante por rota: a listagem também diz qual crachá é o seu, e nenhuma rota precisa decidir se devolve o campo. O Owner sem vínculo não tem linha nenhuma, então nunca é `isSelf` em lista alguma; o vínculo é da pessoa em cada agência separadamente (quem tem dois vínculos recebe `true` só no da agência consultada). O web deixa de comparar e-mails e usa `isSelf`.

**Consequência.** Quem consome o contrato precisa do campo: as fixtures do web e os testes de API que montam o item foram atualizados. É um campo novo, não muda nenhum existente, sem migration e sem backfill. Uma próxima rota que devolva uma pessoa de colaborador usa o mesmo item e herda o campo; não recalcula à mão.

**Origem.** Issue #286, follow-up da revisão de código do PR #283 (#108). **Pendente de validação** pelo dono do produto.

