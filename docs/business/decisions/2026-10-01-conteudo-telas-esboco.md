# Conteúdo: telas (esboço)

**Data.** 2026-10-01

**Contexto.** Bloco 6 da entrevista de Conteúdo. Esboço de telas; aparência vem do design system e do refino do designer.

**Decisão.**
- **Intenção na agência**: Produção e Gestor de conta, todo dia, no desktop, para "planejar o mês de um cliente e fechar o que falta para ir ao ar". Mesa editorial: o mês do cliente à vista e o travado saltando aos olhos.
- **Intenção no portal**: o dono do negócio, pelo celular, poucas vezes por semana, para conferir e aprovar. O item da barra do portal passa de "Calendário" a **"Conteúdos"**.
- **Agência**: item "Conteúdos" (`/agencia/:id/conteudos`) com o **seletor de clientes em stories** (ordem da carteira, anel destacado quando há algo pedindo ação, só ativos); o cliente escolhido vai para a URL (`/agencia/:id/conteudos/:clienteId`); a aba Conteúdos do detalhe do cliente mostra a mesma visão.
- **Calendário e feed**: calendário no mês, com opção de semana; feed 3×3 com os conteúdos de feed não cancelados, do mais recente ao mais antigo, futuros marcados como planejados, sincronizado com o período do calendário. Vídeo longo e VSL só no calendário.
- **Card**: capa, título, tipo, data e hora, status, alerta de prazo ou atraso e percentual das subtarefas. **Detalhe ao passar o mouse**: começo da legenda, responsável, resumo das subtarefas e última mensagem da conversa.
- **Modal** com URL própria: aba Geral (prévia à esquerda; título, tipo, data e hora, pasta com seletor e upload, capa, legenda com contador, conversa) e aba Atribuição (responsável e subtarefas com as ações de cada estado). Os botões seguem o estado e a permissão.
- **Visão "Pastas"** dentro de Conteúdos do cliente, para navegar na biblioteca e subir mídia antes de criar o post.
- **Stories**: o **+** do dia oferece Conteúdo ou Roteiro de stories; o dia com roteiro tem indicador; o roteiro abre em modal próprio, com cenas e "Enviar ao cliente".
- **Portal**: Conteúdos abre com "O que precisa de você" (aguardando aprovação), depois o calendário do mês com filtro por status e a alternância para o feed; o post abre em tela cheia com legenda, mídias navegáveis, Aprovar, Pedir ajuste e a conversa. O Início mostra "N conteúdos esperando sua aprovação" e o roteiro de stories de hoje com "Marcar como gravado". Celular primeiro.
- **E-mails** para todas as pessoas ativas do portal do cliente: "conteúdos para aprovar" agrupado com espera de 15 minutos após o último envio; "publicado" em resumo diário; nada para cliente arquivado ou agência suspensa.
- **Estados de tela**: vazio com criar para quem opera, feed com "planeje o primeiro post"; skeleton na primeira carga; erro com tentar de novo; sem permissão o item não aparece e a URL cai no não encontrado; no portal, "Nenhum conteúdo planejado para este mês".

**Consequência.** O dono aceitou o esboço como ponto de partida, a aprimorar com o uso.

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

