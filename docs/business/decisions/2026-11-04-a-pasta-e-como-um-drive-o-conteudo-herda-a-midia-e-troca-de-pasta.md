# A pasta de mídia funciona como um drive: o conteúdo herda o que a pasta tem, o envio pode ser feito no modal e a pasta pode ser trocada

**Data.** 2026-11-04

**Contexto.** A escolha da mídia no modal do conteúdo era em dois passos: escolher a pasta e, depois, escolher cada mídia dentro dela; o envio de arquivo só existia na visão Pastas; e a pasta ficava travada enquanto o conteúdo tinha mídia ou capa (`409 CONTENT_FOLDER_IN_USE`, com a frase "A pasta não muda enquanto o conteúdo tem mídia ou capa"). O dono achou o fluxo estranho: a pessoa escolhe uma pasta, e o conteúdo deve usar o que há nela, como num drive.

**Decisão.**

1. **Herança.** Ao escolher a pasta, o conteúdo recebe a mídia da pasta que serve ao formato, na ordem em que a pasta a lista (a mais recente primeiro). O carrossel recebe toda a mídia compatível, até o limite de 20; imagem e vídeo recebem a primeira compatível. A pessoa ajusta depois, e nenhum passo extra é pedido. Na criação, a lista vai no próprio pedido de criar. Mídia removida não entra.
2. **Pasta vazia.** O conteúdo fica sem mídia, como numa remoção, e a tela diz que a pasta está vazia e onde enviar a primeira.
3. **Envio pelo modal.** O arquivo enviado dentro do modal vai para a pasta do conteúdo e entra no conteúdo. O envio pela visão Pastas continua e é o mesmo armazenamento.
4. **Mídia nova na pasta não entra sozinha.** A herança acontece uma vez, ao escolher a pasta. O vínculo é a lista gravada em `content_media`; mídia que chega depois à pasta não muda conteúdo existente nem cancela aprovação.
5. **Trocar de pasta é sempre permitido** (exceto em conteúdo publicado ou cancelado, que não se edita). A lista e a capa são substituídas pelo que a pasta nova dá, e a capa volta a nenhuma. A mensagem "A pasta não muda…" e a instrução de tirar a mídia e a capa antes saem; `CONTENT_FOLDER_IN_USE` deixa de existir.
6. **Efeito na aprovação.** É a regra atual de troca de mídia: conteúdo aprovado é anulado e volta para "aguardando aprovação". Antes de trocar, a tela pede confirmação e diz o efeito, quando o conteúdo tem mídia ou capa, ou aguarda ou está aprovado.
7. **Pasta nova vazia.** Conteúdo em produção fica sem mídia. Conteúdo aguardando aprovação ou aprovado não pode ficar incompleto: a troca é recusada com a recusa já existente de mídia incompleta (`409 CONTENT_MEDIA_INCOMPLETE`), com texto próprio da pasta, e nada muda. Nenhuma exceção nova.
8. **Fora do escopo.** Origens externas (Google Drive, link): só o envio de arquivo.
9. **O que não muda.** Conteúdo, pasta e mídia são do mesmo cliente e da mesma agência; o conteúdo só seleciona mídia da própria pasta; mídia usada em conteúdo aprovado ou publicado segue protegida contra remoção; o portal só vê a mídia pelo conteúdo já visível; as permissões são as de antes (`conteudo.operar`).

**Consequência.**

- Migration `20261104000100_content_folder_move_inherits_media`: três funções no banco (`folder_media_for`, `inherit_content_media`, `move_content_folder`). A troca de pasta passa a ser uma operação só no banco, que bloqueia na mesma ordem das demais (cliente, conteúdo, mídia) e não cria deadlock com a remoção de mídia.
- A API deixa de aceitar `folderId` pelo caminho de colunas do `PATCH`: a troca vai pela função. O `POST` aceita `mediaAssetIds` (e herda quando ele não vem).
- Uma troca de pasta em conteúdo com mídia soma 1 ou 2 à revisão; um conteúdo criado com mídia nasce na revisão 2.
- Troca de formato com a lista vazia na tela volta a herdar da pasta.

**Substitui.** O item 4 de [`2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta`](2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta.md) (a pasta trava) e a parte do item 2 dela que dizia que o modal não sobe arquivo; o item 6 de [`2026-10-11-conteudo-editar-aceita-responsavel-e-lista-de-midia-na-mesma-chamada`](2026-10-11-conteudo-editar-aceita-responsavel-e-lista-de-midia-na-mesma-chamada.md) (a pasta só muda sem mídia nem capa).

**Origem.** O dono, em 2026-11-04, nesta sessão.

**Validação.** Pendente de validação do dono.
