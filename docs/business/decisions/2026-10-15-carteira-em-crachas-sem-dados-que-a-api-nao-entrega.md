# Carteira de clientes em crachás: só o que a API entrega

**Data.** 2026-10-15

**Contexto.** A issue #636 (épico #621) redesenha a carteira como grade de crachás. O desenho do canvas traz segmento, contato, responsável, "cliente desde", conteúdos do mês, filtros de responsável, de sinais de conteúdo e de segmento, a alternância Grade/Lista e "Ver todos, com arquivados". A listagem `GET /agencies/:agencyId/clients` entrega só nome, foto, @, situação, data de encerramento, sugestões aguardando, convites pendentes e os cinco indicadores de conteúdo, e filtra só por busca e situação (ativos ou arquivados, nunca os dois).

**Decisão.**
- O crachá mostra apenas o que a listagem entrega: foto ou iniciais, nome, @, situação, selo de triagem, etiquetas, os três números de conteúdo, o número curto e a próxima ação. Segmento, contato, responsável, "cliente desde" e conteúdos do mês ficam de fora até a API entregar.
- A faixa de filtros tem busca e situação (rótulo "Status", que os testes da carteira já fixam). Responsável, sinais de conteúdo e segmento não aparecem, nem desabilitados.
- Não há visão Lista de clientes, então não há alternância Grade/Lista. A Lista só entra com issue própria.
- "Ver todos, com arquivados" vira o link "Ver arquivados" (e "Ver ativos" na visão de arquivados), porque a API não mistura as duas situações. Uma visão com os dois exige `status=all` na API.
- O selo de triagem é um só, na ordem atrasado, prazo em até 2 dias e convite pendente; as sugestões aguardando, o encerramento e o convite que não virou selo seguem como etiquetas. A ordem da carteira continua a do servidor (`sort=attention`).
- O número curto é o número por trás da próxima ação (posts atrasados, posts com prazo em até 2 dias, sugestões para responder ou convites em aberto); sem motivo, não há número e a ação é "Abrir cliente". A ação e o menu de três pontos só levam a abas que o detalhe já tem (Geral, Conteúdos, Estudo de marca, Acessos), cada uma na permissão que o detalhe já exige.
- A frase de triagem do painel é montada com as linhas da primeira página da carteira ativa sem busca; em qualquer outro recorte ela não aparece, porque não descreveria o topo da fila.

**Consequência.** Nenhuma rota, tabela ou permissão muda. Os blocos de contato e de dados do desenho, os três filtros e o "ver todos" real dependem de campos e filtros novos na API, registrados nas issues #660 (campos da listagem) e #661 (`status=all` e filtros).

**Origem.** Implementação da #636 (épico #621); pedido do dono de 2026-10-13 para a tela de Clientes.

**Validação.** Pendente de validação do dono.
