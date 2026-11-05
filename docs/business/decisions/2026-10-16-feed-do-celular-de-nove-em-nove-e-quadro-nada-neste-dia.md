# O feed do celular mostra nove em nove, e o que falta vira o quadro "nada neste dia"

**Data.** 2026-10-16

**Contexto.** A decisão de 2026-10-11, "O feed da agência é a grade do período na tela" (item 1), fez a grade do celular ao lado do calendário mostrar **todos** os posts do período, em colunas de três, sem limite de linhas, e desenhar nove casas pontilhadas quando vazia. Em teste manual, em 2026-10-16, o dono achou o celular feio e apertado: não parece um aparelho, um mês cheio vira uma coluna longa, e a página que não enche deixa espaço em branco. Pediu que o feed mostre sempre nove em nove e que o que não tem conteúdo vire um quadro com o ícone de "nada neste dia", sem espaço em branco. A imagem que ele mandou é um exemplo do visual, não um contrato: não vale por dado que a API não entrega.

**Decisão.**
- O feed é a grade **3×3, nove posts por página**, do mais recente ao mais antigo (a ordem, o que entra e o "Planejado" não mudam). A paginação fica no pé do celular: "Página anterior", "Próxima página" e a faixa "1–9 de N" (com um só post na página, "1 de N"). Os botões do começo e do fim ficam com `aria-disabled`, para o foco do que acabou de ser apertado não se perder.
- A página que não enche termina em **quadros "nada neste dia"**: moldura tracejada com o ícone de calendário riscado, fora da leitura da tela (`aria-hidden`), nunca espaço em branco. O feed vazio desenha os nove quadros e diz "Planeje o primeiro post", sem a paginação.
- A página pertence ao período e ao cliente: ao trocar o mês, a semana ou o cliente, o feed volta à primeira página. Os contadores (no período, prontos, aguardando) continuam sendo os do período inteiro, não os da página.
- O feed é **desenhado num celular**: moldura do aparelho, ilha da câmera, barra de início, mais largo (22 rem) e à vista enquanto o calendário rola. Só mostra o que a API já entrega (o @ do Instagram, a foto e o nome do cliente, os três contadores, a grade): nada de "Editar perfil", "Compartilhar", abas de reels ou de marcações, que não funcionam.

**Substitui em parte** a decisão de 2026-10-11 `conteudo-feed-da-agencia-grade-do-periodo-e-vista-propria`, item 1 ("três colunas, sem limite de linhas"); o resto dela segue, menos o item 6 (a vista Feed), que a decisão de 2026-10-16 `pastas-viram-a-aba-midias-do-cliente-e-o-feed-deixa-de-ser-vista` já substituiu. Nenhuma das duas se edita.

**Consequência.** É só tela: a consulta por período, o teto de itens (500) e a ordem são os mesmos, e a página se corta no navegador. O teste "sem limite de nove" deixa de valer e dá lugar aos de página, de quadro vazio e de volta à primeira página. A SPEC `specs/conteudo.md` (seção 7) foi acertada no mesmo PR. O feed do portal tem desenho e regras próprios e não muda.

**Origem.** Teste manual do dono em 2026-10-16; issue #703.

**Validação.** Pendente de validação do dono.
