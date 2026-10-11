# O modal do conteúdo tem endereço também na criação, escolhe mídia só da pasta e trava a pasta enquanto há mídia ou capa

**Data.** 2026-10-11

**Contexto.** A #264 abre o conteúdo num modal com endereço compartilhável (`/agencia/:agenciaId/conteudos/:clienteId/:conteudoId`) e traz a criação (o "Criar conteúdo" da barra e a opção "Conteúdo" do **+** do dia, que esperavam este modal). A SPEC (seção 7) desenha o formulário, mas não diz qual é o endereço da criação, de onde vem a mídia dentro do modal, nem o que a tela faz quando a API recusa trocar a pasta de um conteúdo que já tem mídia. Decisão tomada pela Âncora ao implementar a parte A da #264 (ver, editar e criar), para a validação do dono.

**Decisão.**

1. **A criação é um endereço irmão do conteúdo:** `/agencia/:agenciaId/conteudos/:clienteId/novo?dia=AAAA-MM-DD`. O dia vem do **+** que abriu o modal, ou é hoje no dia de São Paulo; um `dia` que não é um dia real cai em hoje. Recarregar a página reabre a criação no mesmo dia. Fechar (ou criar) volta ao calendário com o período em que a pessoa estava (`visao` e `data`) e sem o `dia`.
2. **A mídia do modal vem só da pasta do conteúdo.** O modal lista as mídias **confirmadas** da pasta, por página lida até o fim, e não sobe arquivo: subir é da visão Pastas do cliente (#267). Imagem aceita uma imagem, vídeo (Reels, vídeo longo, VSL) aceita um vídeo e o carrossel aceita de 2 a 20, de qualquer tipo, na ordem em que a pessoa as põe; nos formatos de uma mídia só, escolher outra **troca** a escolhida.
3. **Criar e escolher mídia é um gesto só, em dois pedidos.** A API cria sem mídia (`POST`) e grava a lista inteira em seguida (`PATCH`). Se o primeiro passa e o segundo falha, o conteúdo **existe**: o modal fica aberto, diz que ele já foi criado e, ao salvar de novo, reenvia só o que falta, nunca cria outro.
4. **A pasta trava enquanto o conteúdo tem mídia ou capa.** É a regra da API (`CONTENT_FOLDER_IN_USE`); a tela mostra a pasta travada com o motivo e orienta tirar as duas, salvar, e então trocar. Só um conteúdo sem mídia nem capa troca de pasta, e criar uma pasta nova (dentro de uma de primeiro nível ou no primeiro nível) está no próprio modal.
5. **Só vídeo tem capa.** Trocar o formato para imagem ou carrossel tira a capa no mesmo pedido que muda o formato.
6. **O aviso da regra 6 vem antes de salvar.** Num conteúdo **aprovado**, mudar a legenda, a mídia, a capa ou o formato mostra, antes do botão, que ele volta para "Aguardando aprovação"; mudar título, data ou hora não avisa, porque mantém a aprovação.
7. **O responsável não aparece nem se edita no Geral.** Ele pertence à aba Atribuição (#265); o `owner { membershipId, name }` da #552 só é nome no detalhe do card do calendário.

**Alternativas fechadas.** Criar sem endereço, com o modal só em estado de memória: a criação não sobreviveria a um recarregar e o **+** não teria um dia para guardar. Subir arquivo dentro do modal: duplicaria o envio da visão Pastas e traria o upload em partes para dentro de um formulário.

**Consequência.**

- Nenhuma rota, tabela, migration ou permissão nova: só a tela, sobre as rotas de #253, #254 e #256.
- O conteúdo recém-criado nasce "em produção", sem responsável escolhido na tela: a API põe quem criou.
- Quem só tem `conteudo.visualizar` abre o modal e lê tudo; sem `conteudo.operar`, ou com o cliente arquivado, os campos ficam desabilitados e a criação mostra o motivo no lugar do formulário.

**Origem.** Issue #264, parte A; SPEC `specs/conteudo.md`, seções 3, 4 (regra 6) e 7.

**Validação.** Pendente de validação do dono.
