# Adicionar pessoa de novo solta a conta que já não tem aquele e-mail, e Reativar não

**Data.** 2026-10-27

**Contexto.** O acesso passa à conta no login e, depois de vinculado, é da conta: a troca de e-mail dela não o desfaz (decisão de 2026-10-26, item 3). Daí vem o caso da revisão do PR #720: a conta A tinha Y, trocou para Z, e a agência adiciona Y de novo. Reativar a mesma linha devolveria o portal a A, que já não é quem tem Y, e quem tem Y hoje não conseguiria vincular, porque o vínculo nunca pega um acesso que já tem conta.

**Decisão.**

1. **Adicionar pessoa** num e-mail cuja linha tem conta que **já não tem aquele e-mail** solta a conta: `user_id` fica nulo, o membership dela vira removido, e a linha fica ativa para quem tem o e-mail agora vincular no login. Vale para a linha removida e para a que ainda estava ativa. Quando a linha estava ativa, a conta perdeu o portal, e as sessões dela terminam como em qualquer remoção.
2. **Reativar** (pelo id, na lista de removidos) devolve o portal à conta vinculada, mesmo que ela tenha trocado de e-mail: é a agência dizendo que é aquela pessoa. Só **adicionar o e-mail** diz que é quem tem o e-mail agora.
3. **Aceitar um convite de portal antigo** segue a mesma regra do item 1: quem aceita tem o e-mail do convite, então o endereço passa para essa conta, e a conta anterior sai.
4. Em todos os casos a linha é a mesma e a geração fica como a remoção a deixou. Reativar não ressuscita link de aprovação antigo.

**Consequência.** Não muda tabela. Está nas funções `add_client_portal_access`, `reactivate_client_portal_access` e `grant_client_portal_access_from_invitation`. A rota "Adicionar pessoa" encerra as sessões da conta solta.

**Origem.** Observação 1 do comentário da issue #711 (revisão aprovada do PR #720). A distinção entre Adicionar e Reativar é da implementação.

**Validação.** Pendente de validação do dono.
