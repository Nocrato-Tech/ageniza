# Pastas de mídia e upload na Pauta: ação secundária, vazio sem mascote e só o que a API entrega

**Data.** 2026-10-15

**Contexto.** A issue #634 (épico #621) redesenha a visão Pastas do cliente, a lista de arquivos e o upload. O canvas de referência não tem artboard de Pastas nem de upload (só Calendário, Modal do conteúdo, Clientes, Clientes vazio, Login, Erro 404 e Portal), então a tela foi composta com a linguagem dessas peças e as regras da seção 25 do design system. A aba Pastas fica sob o cabeçalho do Calendário Editorial, que já traz a ação primária da página ("Nova publicação"). As rotas de pastas e de mídias entregam, por pasta, só `id`, `parentId`, `name`, `isDefault` e `createdAt`; por mídia, só categoria, tipo, tamanho, estado do vídeo e data.

**Decisão.**
- Nenhum botão da visão Pastas é índigo cheio: "Nova pasta", "Nova pasta de trabalho", "Enviar mídia", "Enviar", "Tentar de novo", "Baixar" e "Cancelar envio" são secundários, e "Remover" é terciário. A ação primária da tela continua sendo a da página, uma só (25.2). O botão "Criar pasta" do diálogo segue primário, porque o diálogo é a própria camada de uma tarefa.
- O seletor de arquivo é um `Button` ("Enviar mídia") ao lado do título "Mídias". O `<input type="file">` nativo continua no DOM, escondido da tela e da tecnologia assistiva (`aria-hidden`, fora da ordem de tabulação), porque o botão abre o mesmo seletor e dois controles com o mesmo nome confundiriam quem usa leitor de tela. Pasta sem mídia mostra o seletor dentro do estado vazio, no lugar do botão do título, para a ação não aparecer duas vezes.
- O progresso do envio é uma barra neutra (tinta sobre `bg/hover`, não-texto acima de 3:1) com o número em tabular: o índigo cheio fica com os quatro usos de 25.2 e o envio em curso não é um deles.
- O estado vazio das pastas e das mídias usa o `EmptyState` sem mascote, compacto e centralizado. Com o mascote o título do `EmptyState` passa a 32 px, um quarto tamanho de texto numa tela de trabalho, e a coruja não vai em tela de trabalho cheia (docs/brand.md).
- Ícones são `lucide-react` em traço 1,75: pasta, imagem, vídeo, download, lixeira, upload, alerta. Os caracteres `▤`, `▣`, `▶` e `›` saem.
- Sem arrastar e soltar: seria função nova, e a issue proíbe.
- Fica de fora o que a API não entrega: quantidade de mídias por pasta, nome original do arquivo, quem enviou e duração do vídeo. O cartão da pasta e da mídia dizem só o que há; os campos entram pela issue de API #671 e depois pela tela.

**Consequência.** Nenhuma rota, tabela, permissão ou texto de erro muda; os testes de pastas e de upload continuam verdes sem alteração. Os blocos que dependem de dados novos esperam a #671.

**Origem.** Implementação da #634 (épico #621); regras da Pauta (seção 25 do design system) e aceite visual comum do épico.

**Validação.** Pendente de validação do dono.
