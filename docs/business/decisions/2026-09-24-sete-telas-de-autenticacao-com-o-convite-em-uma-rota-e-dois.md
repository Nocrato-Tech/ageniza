# Sete telas de autenticação, com o convite em uma rota e dois estados
**Data.** 2026-09-24

**Contexto.** O módulo não tem nenhuma tela, e o backend já decide mais do que a interface costuma assumir: `GET /me/contexts/resolve` devolve `none`, `enter` ou `select`, e `GET /invitations/:token` devolve `accountExists`.

**Decisão.** Sete telas: **Entrar**, **Esqueci a senha**, **Redefinir senha**, **Convite**, **Escolher contexto**, **Acesso encerrado**, e as páginas de **Termos** e **Privacidade**. "Link inválido" é **estado** das telas de convite e reset, não tela própria.

- **O convite é uma rota com dois estados.** A URL é a mesma que chegou no e-mail; `accountExists` escolhe entre confirmar e preencher nome, senha e Termos. Os dois estados mostram para qual agência, qual cliente quando houver, e para qual e-mail o convite foi endereçado.
- **O reset continua o convite automaticamente.** A API já carrega o `inviteToken` pelo fluxo de recuperação e autentica no fim; mandar a pessoa buscar o e-mail de convite de novo seria pedir que ela reconstruísse à mão um estado que o servidor já tem.
- **Seletor de contexto: tela própria depois do login, menu durante o uso.** No login a escolha é bloqueante e não há contexto ativo; durante o trabalho, trocar é ação secundária. `PUT /me/last-context` é gravado nos dois casos, e é isso que faz o segundo login não repetir a pergunta.
- **Menu de conta no cabeçalho** em toda tela autenticada, com o contexto ativo, sair e sair de todas as sessões — sem ele, `POST /auth/logout-all` existe na API e é inalcançável na interface.
- **As rotas do navegador são em português**: `/entrar`, `/convite/:token`, `/senha/esquecida`, `/senha/redefinir`, `/contextos`, `/termos`, `/privacidade`. As rotas da API continuam em inglês; só uma das duas camadas é lida por gente, e o link de convite vai por e-mail.

**Consequência.** A interface obedece o `resolve` em vez de recalcular a decisão, o que mantém uma única fonte para "onde esta pessoa entra". Qualquer tela nova de autenticação herda as convenções da seção 7 de `specs/autorizacao.md`.

**Origem.** Decidido em sessão (entrevista do módulo de autenticação).

