# Calendário na Pauta: card tingido pelo formato, estado na etiqueta e atrasado em bloco cheio

**Data.** 2026-10-15

**Contexto.** A #631 (parte 2) desenha o card do post na grade do mês. O pedido do dono tinge o card pelo formato, e a direção Pauta indicava o estado pela cor do card; o goal propôs resolver o conflito com o estado na etiqueta. Os tipos de conteúdo da tela são cinco (imagem, carrossel, reels, vídeo longo, VSL) e as etiquetas de domínio têm três tons de formato e cinco estados.

**Decisão.**
- O fundo e o título do card seguem o formato: carrossel (teal), reels (violeta) e neutro para imagem, vídeo longo e VSL. A etiqueta de formato, preenchida, usa o nome do formato como a tela já o escreve ("Imagem", "Vídeo longo").
- O estado fica numa etiqueta com contorno. "Cancelado" usa o ícone vazio de "Em produção" com a palavra "Cancelado"; não há ícone próprio.
- Atrasado é o único bloco cheio (vermelho), vem logo depois do formato e dá ao card a borda vermelha; a etiqueta do estado continua, porque o card atrasado ainda tem um estado.
- O título começa com o formato ("Carrossel: …"), em até 4 linhas; o horário, quando existe, fica numa linha própria. Post sem mídia é só texto: a forma do formato continua no DOM, mas não é desenhada.
- A faixa de clientes da tela é o ClientStrip do design system, com o anel de atenção do Avatar.

**Consequência.** Nenhuma rota, tabela ou permissão muda. O cartão flutuante do hover e o arrastar são da #632. Um formato novo precisa de tom próprio na tabela do card.

**Origem.** Implementação da #631 (épico #621), pedido do dono de 2026-10-13.

**Validação.** Pendente de validação do dono.
