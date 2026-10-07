# Conteúdo: pastas de mídia, estados e transições

**Data.** 2026-10-01

**Contexto.** Blocos 3 (fim) e 4 da entrevista de Conteúdo.

**Decisão.**
- **Pastas**: todo cliente nasce com uma lista fixa de pastas padrão do sistema (Vídeos, Imagens, Carrosséis, Ensaio fotográfico); a agência pode criar pastas próprias no primeiro nível. **Dois níveis**: pasta padrão e, dentro dela, pastas de trabalho. **Uma pasta pode servir a vários conteúdos** (um ensaio que vira vários posts): o conteúdo aponta para uma pasta e seleciona as mídias dela.
- **O portal vê mídia só pelo conteúdo** que já pode ver (a partir de "aguardando aprovação"); a biblioteca não aparece no portal no MVP. Em aberto, com gatilho "o primeiro cliente pedir para baixar o material entregue".
- **Estados do conteúdo**: em produção → aguardando aprovação → aprovado (na agência, "pronto para publicar") → publicado; aguardando aprovação → em ajuste → aguardando aprovação; qualquer estado menos publicado → cancelado → (reagendar) em produção. "Atrasado" não é estado: é a data passada sem publicado nem cancelado.
- **Enviar para aprovação** exige mídia completa para o tipo e todas as subtarefas aprovadas; legenda opcional.
- **Pedir ajuste** exige comentário, que entra na conversa do conteúdo.
- **Editar depois de aprovado**: mudar legenda, mídia, capa ou tipo anula a aprovação e devolve a "aguardando aprovação"; mudar data, hora, título, responsável ou subtarefas mantém.
- **Publicado** pode ser desfeito **no mesmo dia** por quem tem `conteudo.publicar`, voltando a aprovado; depois disso é final.
- **Arrastar para outra data** vale em todos os estados menos publicado e cancelado, sem anular a aprovação.
- **Subtarefa**: pendente → entregue (pelo responsável dela) → aprovada (pelo responsável do conteúdo) ou devolvida com comentário, voltando a pendente. Atraso é prazo passado sem aprovada.
- **Roteiro de stories**: rascunho → enviado (aparece no portal) → gravado (marcado pelo cliente).

**Consequência.** A mídia passa a ter cliente e pasta, e a leitura do portal sobre mídia é derivada do conteúdo. Os estados são impostos no banco, não só na rota (bloco de regras).

**Origem.** Decidido pelo dono do produto em sessão (entrevista do módulo Conteúdo), em 2026-10-01.

