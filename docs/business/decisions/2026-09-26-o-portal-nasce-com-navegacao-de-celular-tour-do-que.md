# O portal nasce com navegação de celular, tour do que funciona e sem notificação
**Data.** 2026-09-26

**Contexto.** O portal não tem tela nenhuma, e a única rota de cliente é a que marca o onboarding como visto. O sistema só envia e-mail de autenticação; não existe notificação de nenhum tipo.

**Decisão.**

- **Rotas** `/portal/:clienteId/...`, em português como as de autenticação. **Barra inferior** com Início, Calendário, Marca e Relatórios; Calendário e Relatórios nascem como esqueleto. Quem acessa mais de um cliente troca pelo menu de conta já decidido em auth.
- **Início**: saudação com o nome do cliente e a próxima ação óbvia — no MVP, "a agência respondeu N sugestões suas" ou "conheça o estudo da sua marca" —, com o espaço dos conteúdos a aprovar reservado.
- **Onboarding**: tour guiado na primeira entrada daquela pessoa naquele cliente, usando o `onboarding_seen_at` que já existe; pode ser pulado e revisto pelo menu de conta. **Mostra só o que funciona** — no MVP, Marca e como sugerir.
- **Estudo de marca no portal**: seções em leitura, em linguagem de cliente; **Sugerir** e as conversas em cada seção; seção não preenchida diz "sua agência está preparando esta parte"; o cliente vê nome e foto de quem respondeu.
- **Aba Acessos** na agência: pessoas no portal com Remover e Reativar, removidas num filtro; convites pendentes com Reenviar e Cancelar; Convidar é um modal só com o e-mail; vazio "ninguém deste cliente acessa o portal ainda", com Convidar. O mesmo desenho da seção de convites de Colaboradores.
- **Sem notificação no MVP**: cada lado descobre a conversa dentro do produto — o selo na listagem da agência, o aviso no Início do portal.

**Consequência.** Notificação fica em aberto, com gatilho: **Conteúdo fechar o fluxo de aprovação** — é ali que o cliente precisa ser chamado de fora, e notificação é mecanismo transversal (destinatário, preferência, agrupamento) que não deve ser desenhado para o caso menos urgente. O risco aceito é o cliente sugerir e só ver a resposta na entrada seguinte.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

