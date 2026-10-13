# Login no lançamento é só e-mail e senha

**Data.** 2026-10-13

**Contexto.** Com o cadastro público, o dono avaliou deixar a agência criar conta com Google, para não depender de guardar dados dela. O login com Google não tira o nome, o e-mail nem a sessão do nosso banco; tira só o hash da senha. Ele também não serve a agência que não usa Google, nem os clientes do portal. E todo fluxo já construído (convite amarrado ao e-mail, redefinição e troca de senha, troca de e-mail confirmada pela senha atual) supõe uma senha.

**Decisão.** No lançamento, o cadastro e o login são por e-mail e senha, como já existem. Login com Google fica em aberto.

**Consequência.** Em aberto, com gatilho: login com Google entra quando a taxa de abandono no cadastro do teste grátis justificar, e exige decidir o vínculo de conta pelo mesmo e-mail verificado e o caso de conta sem senha nos fluxos que pedem a senha atual.

**Origem.** Entrevista do módulo entrada, 2026-10-13.

**Validação.** Validada pelo dono em 2026-10-13.
