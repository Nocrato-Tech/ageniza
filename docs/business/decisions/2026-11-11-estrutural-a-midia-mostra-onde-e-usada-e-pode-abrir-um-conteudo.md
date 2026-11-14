# ESTRUTURAL: a mídia mostra onde é usada, e "Usar em um conteúdo" abre um conteúdo novo com o arquivo escolhido

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho (r0) mostra, na biblioteca, "Usado em N posts" com o estado de cada post e, no painel do arquivo, "Usada em" e a ação "Usar em um conteúdo". A decisão [`2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta`](2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta.md) manda que a mídia de um conteúdo se escolha **no modal do conteúdo**, só da pasta dele; hoje a biblioteca não liga o arquivo a conteúdo nenhum na tela.

**Decisão.**

1. **Onde é usado.** O painel do arquivo e a tabela mostram **em quantos conteúdos** o arquivo é usado e **quais** (título e estado), contando o uso como mídia do post e como capa. O que a pessoa não pode ler (sem `conteudo.visualizar`) não aparece.
2. **"Usar em um conteúdo".** Abre o formulário de **conteúdo novo** do cliente (`conteudos/:clienteId/novo`) **com aquele arquivo já escolhido** na pasta dele. Não cria nada sozinho, não coloca o arquivo num conteúdo que já existe e só vale para **foto e vídeo** (PDF, áudio e logo não entram num conteúdo). O conteúdo novo herda, uma vez, a pasta do arquivo, como já é.
3. **A mídia continua escolhida no conteúdo.** O modal do conteúdo segue sendo o lugar em que a mídia de um conteúdo se escolhe e se troca; "Usar em um conteúdo" é só um atalho de entrada, e a regra de que o conteúdo só usa mídia da pasta do próprio cliente não muda.

**Substitui.** O trecho de [`2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta`](2026-10-11-modal-do-conteudo-endereco-de-criacao-e-midia-so-da-pasta.md) que diz que a mídia só se escolhe no modal do conteúdo, no que ela admite entrar por "Usar em um conteúdo" como arquivo pré-escolhido. O resto (o endereço de criação e a mídia só da pasta) continua.

**Consequência.**

- **É estrutural** pelo que o dono pediu e pelo critério de [`structural-changes.md`](../structural-changes.md): muda como a mídia é lida (uma leitura de uso que cruza `media_assets`, `content_media` e `contents`, com RLS de dois módulos) e muda o formato de resposta da lista de mídia que as telas copiam. **Nenhuma tabela muda e não há backfill:** o uso se deriva de `content_media` e da capa do conteúdo.
- **Risco: Médio.** Leitura entre dois módulos sob a RLS do conteúdo (o uso de um conteúdo que a pessoa não lê não vaza). Mutação para: o uso não mostra conteúdo de outro cliente nem de outra agência, e o atalho recusa tipo que não é foto ou vídeo.
- O fluxo mobile da agência descreve o uso e o atalho.

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de abrir "Usar em um conteúdo" como atalho (risco 19 do inventário).

**Validação.** Validada pelo dono em 2026-11-12.
