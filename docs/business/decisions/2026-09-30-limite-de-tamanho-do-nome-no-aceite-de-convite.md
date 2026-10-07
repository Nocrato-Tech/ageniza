# Limite de tamanho do nome no aceite de convite

**Data.** 2026-09-30

**Contexto.** A revisão de segurança do PR #200 (#101) achou que o nome do aceite de convite (`packages/contracts/src/invitations.ts`) aceitava até 256 caracteres sem as proteções do `DisplayNameSchema`. A issue #205 aplica o schema compartilhado, mas ele fixa o limite em 120, e a SPEC de autenticação (`specs/auth.md`) define a senha mínima desse fluxo e **não** define limite de nome.

**Decisão.** O aceite de convite mantém o limite de **256** caracteres para o nome, agora com as mesmas regras do perfil (sem controles, sem overrides bidi, sem invisíveis, exigindo ao menos uma letra ou número). O schema compartilhado passa a ser uma fábrica (`createDisplayNameSchema(maxLength)`) para que cada fluxo declare o próprio limite sem duplicar as regras.

**Consequência.** 256 continua sendo o teto do fluxo de convite. Se o dono do produto quiser alinhar com os 120 do perfil, é mudança de uma constante (`INVITATION_NAME_MAX_LENGTH`) e do teste correspondente — sem migration nem mudança de formato.

**Origem.** Issue #205. **Pendente de validação** — o número foi mantido da implementação anterior porque a SPEC não o define.

