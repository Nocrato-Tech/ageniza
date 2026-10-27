# O convite de portal pendente não se reenvia: espera vencer

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-26 acaba com a criação do convite de portal com token e deixa os pendentes aceitáveis até vencer. Reenviar um convite revoga o atual e cria outro com token novo e validade nova: seria criar um convite de portal.

**Decisão.** Reenviar um convite de portal responde 409 `PORTAL_INVITATION_DISCONTINUED`. O convite pendente segue válido até vencer, e pode ser cancelado. Quem precisa de outro caminho usa "Adicionar pessoa", que dá o acesso na hora. A rota `POST /agencies/:agencyId/clients/:clientId/invitations` deixa de existir.

**Consequência.** A seção de convites aguardando aceite some quando o último convite antigo vencer (`specs/clientes.md`). O reenvio de convite de colaborador não muda.

**Origem.** Decisão de 2026-10-26, item 7. Aplicada ao reenvio pela implementação (issue #711).

**Validação.** Pendente de validação do dono.
