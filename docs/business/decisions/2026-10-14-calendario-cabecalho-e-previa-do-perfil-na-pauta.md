# Calendário na Pauta: cabeçalho, ação "Nova publicação" e contadores da prévia do perfil

**Data.** 2026-10-14

**Contexto.** A issue #631 redesenha o Calendário Editorial. O desenho traz o botão "Nova publicação", uma alternância Grade/Lista e, na prévia do perfil, contadores. A tela atual não tem visão em Lista, e a API não entrega o total de publicações do perfil.

**Decisão.**
- O botão que abre o modal de criação passa a se chamar "Nova publicação" (antes "Criar conteúdo"); o botão de envio dentro do modal continua "Criar conteúdo".
- Não há visão em Lista: a tela mantém as visões Calendário, Feed e Pastas, desenhadas como grupo segmentado. A Lista só entra com uma issue própria.
- Os contadores da prévia do perfil contam o período em tela, a partir da listagem já lida: posts do feed no período, prontos (aprovados) e aguardando aprovação. Nenhum total histórico é exibido.
- Cada quadro do feed mostra o estado do post em texto curto (Produção, Aguardando, Em ajuste, Pronto, Publicado).

**Consequência.** Nenhuma rota, tabela ou permissão muda. A visão Lista e o total histórico de publicações ficam fora até haver regra e dado de API.

**Origem.** Implementação da #631 (épico #621).

**Validação.** Pendente de validação do dono.
