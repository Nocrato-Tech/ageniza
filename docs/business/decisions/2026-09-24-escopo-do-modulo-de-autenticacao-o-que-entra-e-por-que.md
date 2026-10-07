# Escopo do módulo de autenticação: o que entra, e por que verificação de e-mail já está resolvida

**Data.** 2026-09-24

**Contexto.** O backend de autenticação, convites e contextos está implementado desde as issues #31, #32 e #33, sem nunca ter passado por uma SPEC. Ao fechar o escopo, três capacidades foram levantadas como faltantes: verificação de e-mail, alteração de senha por quem está logado, e troca de e-mail.

**Decisão.** O módulo cobre **login, recuperação de senha, aceite de convite com conta existente, criação de conta no aceite com Termos, resolução e seleção de contexto, troca de contexto, logout e logout de todas as sessões**.

Sobre as três levantadas:

- **Verificação de e-mail já está satisfeita, e não por omissão.** `apps/api/src/modules/invitations/routes.ts` cria a conta com `emailVerified = true` porque o convite chegou naquele endereço e o token só existe lá. Um passo de verificação depois pediria à pessoa que provasse de novo o que o link já provou.
- **Alteração de senha por quem está logado fica fora do MVP.** A recuperação por link, que já existe, atende o caso real de quem perdeu o acesso.
- **Troca de e-mail fica fora do MVP**, com gatilho: o primeiro colaborador ou cliente real pedir. Até lá é operação, pelo mesmo caminho por onde a agência nasce.

**Consequência.** Nenhuma das três exige backend novo agora. Se a troca de e-mail entrar, ela traz rota, token, e-mail transacional e **aviso ao endereço antigo** — sem esse aviso, quem rouba uma sessão troca o e-mail e a pessoa perde a conta em silêncio.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

