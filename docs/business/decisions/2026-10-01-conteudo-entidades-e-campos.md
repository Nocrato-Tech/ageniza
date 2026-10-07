# Conteúdo: entidades e campos

**Data.** 2026-10-01

**Contexto.** Bloco 3 da entrevista de Conteúdo.

**Decisão.**
- **Vendas e Financeiro** não veem a aba Conteúdos do cliente nem os indicadores derivados de conteúdo; a carteira deles mantém a ordem atual (conversas esperando resposta, depois nome).
- **Data de publicação** com **hora opcional**; o atraso é medido pela data, no fuso `America/Sao_Paulo` enquanto o fuso por agência (#153) não existir.
- **Formatos**: imagem (1), carrossel (2 a 20 itens, imagem ou vídeo, ordenados), reels (1 vídeo), vídeo longo (1), VSL (1); legenda até 2.200 caracteres; título interno até 120. Os limites seguem o Instagram no MVP, **mas o modelo não se amarra a ele**: formato e limite são por plataforma, para a expansão futura.
- **Capa de vídeo**: imagem enviada pela agência, ou o quadro automático que o worker já gera.
- **Subtarefa**: título, descrição opcional, responsável obrigatório (colaborador ativo), prazo obrigatório (data) e estado; o percentual do conteúdo é a razão entre subtarefas aprovadas e o total, e não aparece sem subtarefas.
- **Responsável pelo conteúdo** obrigatório, por padrão quem criou, trocável por quem tem `conteudo.operar`.
- **Comentários**: uma conversa por conteúdo, no formato da conversa do estudo de marca (`content_id` na tabela de threads), reaberta quando o cliente comenta.
- **Roteiro de stories**: cliente, data, cenas ordenadas (texto e orientação opcional) e estado gravado, com quem marcou e quando. Sem comentário no MVP.
- **Mídia organizada em pastas por cliente**: cada cliente tem pastas padrão (vídeos, imagens, carrosséis, ensaio fotográfico…). Ao criar um conteúdo, a mídia é atrelada a uma pasta: escolhe-se uma existente ou cria-se uma nova dentro das padrões. O upload é do **conteúdo pronto**; o material bruto fica fora (Drive). O detalhe do modelo é decidido na rodada seguinte.

**Consequência.** A mídia deixa de ser só da agência: passa a ter cliente e pasta. É a estrutural pendente "cliente na mídia" (2026-09-26), cuja forma agora é **por pasta do cliente**, e que será registrada como estrutural no bloco de impacto desta entrevista. Fica em aberto, com gatilho "a entrevista de Tarefas": a regra antiga de que todo colaborador vê Tarefas, diante de tarefas que mostram o título do conteúdo.

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

