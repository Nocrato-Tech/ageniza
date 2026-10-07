# ESTRUTURAL: Termos e Privacidade mudam de versão sem forçar o reaceite, e o aceite depois do cadastro é por documento

**Data.** 2026-10-07

**Contexto.** A decisão de 2026-09-24 sobre Termos e Privacidade deixou o reaceite em aberto, com gatilho: a primeira alteração de um dos documentos depois de existir gente com conta. O contrato de aceite era um só (`acceptTerms: true`, que grava as duas versões), então uma conta não tinha como aceitar um documento sem o outro. Issue #81.

**Decisão.** O dono decidiu **não forçar** o reaceite.

1. Quando a versão em vigor de Termos ou de Privacidade é mais nova que a última aceita pela conta, um aviso **não bloqueante** aparece no topo da casca da agência e do portal, com link para o texto e o botão "Li e aceito". Fechar sem aceitar é permitido; o aviso volta no próximo login.
2. O aceite é **por documento e por versão**: `POST /me/legal-acceptances` com `{ document: 'terms' | 'privacy' }`. A versão gravada é sempre a em vigor no servidor (`AUTH_TERMS_VERSION`, `AUTH_PRIVACY_VERSION`), **nunca** uma que o cliente envie; repetir é idempotente; aceitar uma versão que a conta já superou não grava nada. Aceitar a Privacidade não marca os Termos.
3. Nenhuma funcionalidade fica bloqueada por falta do aceite novo. A conta continua vinculada à última versão aceita de cada documento, e `GET /me/legal-acceptances` a devolve.
4. O cadastro (aceite de convite com conta nova) continua aceitando as duas versões em vigor, com o checkbox único.

**Consequência.** É estrutural porque muda o contrato de aceite e abre um segundo caminho de escrita em dado pessoal: `app_private.accept_legal_document(document, version)`, função `security definer` de escopo único que toma o usuário do ator da transação, nunca de um argumento. Tabela, colunas, grants e policies de `legal_acceptances` não mudam: `ageniza_app` continua sem INSERT direto, como o teste de tenancy já fixava. Não há backfill: conta sem linha para um documento aparece como pendente. As rotas ficam num módulo próprio, `legal`, sem permissão nomeada, por paridade com `/me/profile`: o aceite é da conta, não de um tenant. A versão de um documento é a data em que o texto passou a valer: uma data de verdade e nunca futura, conferida pela função e pela configuração (`AUTH_TERMS_VERSION`, `AUTH_PRIVACY_VERSION`), porque uma versão futura gravada como aceite suprimiria para sempre toda versão real depois dela (achado da revisão de segurança do PR #318). Negar o login ou uma rota por falta de aceite é o oposto desta decisão e a reabre.

**Origem.** Issue #81, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação pelo dono do produto.**

