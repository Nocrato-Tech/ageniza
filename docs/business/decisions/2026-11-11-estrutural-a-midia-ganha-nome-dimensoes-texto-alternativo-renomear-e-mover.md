# ESTRUTURAL: a mídia guarda nome, dimensões e texto alternativo, mostra quem enviou, e o arquivo pode ser renomeado e movido

**Data.** 2026-11-11

**Contexto.** A biblioteca de mídia de um cliente mostra o arquivo sem nome (o rótulo é "Imagem" ou "Vídeo"), sem dimensões e sem texto alternativo, e só lista, envia e remove. O quadro do redesenho (r0) tem o nome do arquivo, "Foto · 4,2 MB · enviada hoje", dimensões "3024×4032", "Enviada por", o campo "Texto alternativo", a busca "Buscar nesta biblioteca", o menu "Abrir, Baixar, Mover para, Renomear, Excluir" e a tabela "Enviados recentemente". A tabela `media_assets` não guarda o nome do arquivo (o `fileName` só existe no pedido de envio), e a chave do objeto no armazenamento nunca vem do cliente.

**Decisão.**

1. **Nome do arquivo.** Cada mídia guarda o **nome** que a pessoa deu ao enviar (o do arquivo, sem caminho), que é o que a biblioteca, a busca e a tabela mostram. O nome é só rótulo: **a chave do objeto no armazenamento não muda** e nunca vem do nome.
2. **Dimensões.** Largura e altura são gravadas no **processamento** (foto e vídeo) e mostradas nos detalhes; ficam em branco enquanto o processamento não termina ou quando não se aplicam (PDF, áudio).
3. **Texto alternativo.** Campo opcional, de até 500 caracteres, que a agência edita no painel do arquivo. Fica com a mídia, para a legenda de acessibilidade do post.
4. **Quem enviou.** O painel mostra "Enviada por <nome> · em <dia>" a partir de quem fez o envio (que a tabela já guarda). O envio feito pelo cliente no portal aparece como do cliente (ver [`2026-11-11-estrutural-o-cliente-envia-material-pelo-portal`](2026-11-11-estrutural-o-cliente-envia-material-pelo-portal.md)).
5. **Renomear e mover.** Quem tem `conteudo.operar` renomeia o arquivo e o **move** para outra pasta **do mesmo cliente**. Mover não muda o arquivo nem o conteúdo que já o usa; mover um arquivo que está em uso por conteúdo aguardando, aprovado ou publicado é recusado (a mesma regra da remoção, regra 12 de `specs/conteudo.md`). Cliente arquivado e agência somente leitura recusam.
6. **Busca na biblioteca.** A caixa "Buscar nesta biblioteca" filtra os arquivos do cliente pelo **nome**. A tabela "Enviados recentemente" lista os arquivos do cliente por ordem de envio.
7. **Sem aba Atividade.** A aba "Atividade" do painel do quadro **não entra**: quem enviou e quando já estão nos Detalhes, e um histórico de alterações do arquivo é o rastreio de alteração de dados da lista de [`structural-changes.md`](../structural-changes.md), que só se abre quando virar requisito.
8. **Pastas com contagem.** A lista de pastas mostra a quantidade de arquivos por tipo, o tamanho e a última atualização, e o acesso rápido mostra a pasta em uso (leitura derivada; nenhuma coluna de pasta muda).

**Substitui.** Nada que tenha sido decidido: a tabela guardava só a chave, o tipo e o tamanho ([`2026-09-18-midia-e-escopada-por-agencia-sem-vinculo-com-cliente`](2026-09-18-midia-e-escopada-por-agencia-sem-vinculo-com-cliente.md) já foi estendida pelo módulo Conteúdo com cliente e pasta). Renomear e mover são ações novas; a regra 12 da remoção passa a valer também para mover.

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (`media_assets` ganha o nome, a largura, a altura e o texto alternativo, todos anuláveis) e precisa de grant por coluna para a edição do nome e do texto alternativo. **Sem backfill:** a mídia que já existe fica sem nome (a tela mostra o rótulo de antes: "Imagem", "Vídeo"), sem dimensões e sem texto alternativo; nada é reescrito.
- **Risco: Alto** (armazenamento e RLS da mídia). Pede revisão de segurança independente e mutação para: nome com caractere de controle ou comprimento, o nome nunca virar chave, mover para pasta de outro cliente ou de outra agência, mover mídia em uso, renomear em cliente arquivado e em somente leitura.
- O fluxo mobile da agência descreve os campos, a busca e as ações.

**Origem.** Pedido do dono do produto em 2026-11-11 ("pode mexer no backend") e decisão do maestro sobre o que a mídia guarda.

**Validação.** Pendente de validação do dono.
