# ESTRUTURAL: a mídia aceita PDF, áudio e SVG (como logo), e o SVG nunca é servido como página

**Data.** 2026-11-11

**Contexto.** A mídia aceita só imagem (`png`, `jpeg`, `webp`, `gif`) e vídeo (`mp4`, `quicktime`, `webm`); qualquer outro tipo é recusado ([`2026-09-18-tipos-de-midia-aceitos-definidos-em-codigo`](2026-09-18-tipos-de-midia-aceitos-definidos-em-codigo.md)). O quadro do redesenho (r0) lista na biblioteca os tipos Foto, PDF, Vídeo e Logo, e o portal pede um depoimento gravado (áudio). Um SVG pode carregar script; por isso é a única novidade com risco de execução.

**Decisão.**

1. **Tipos.** A biblioteca passa a ter cinco tipos: **Foto**, **Vídeo**, **PDF**, **Áudio** e **Logo**. PDF (`application/pdf`) e áudio (MP3, M4A, WAV e a gravação do navegador, WebM e Ogg) entram como arquivos de apoio. **Logo** é uma imagem que a agência marca como logo: PNG, JPEG ou WebP marcados, e **SVG, que só é aceito como logo**.
2. **Só foto e vídeo entram num conteúdo.** PDF, áudio e logo ficam na biblioteca: não são mídia de post nem capa. O Instagram não os aceita, e a escolha de mídia do conteúdo continua só com foto e vídeo.
3. **Regra de servir o SVG.** O SVG **nunca é aberto como documento** na origem do app nem de outra origem que a pessoa navegue, e **nunca é inserido inline** no HTML:
   - para **mostrar**, só como imagem (`<img>`), em que o navegador não executa script;
   - para **abrir ou baixar**, só como **download** (`Content-Disposition: attachment`) com o tipo forçado ao que o servidor confirmou (`response-content-type`), e nunca em nova aba como página. Os dois vão **dentro da assinatura da URL**: quem tem a URL não consegue tirar nem trocar nenhum deles, e o navegador baixa o arquivo no tipo confirmado em vez de adivinhar um e abri-lo. O `X-Content-Type-Options: nosniff` não pode ser acrescentado a uma URL assinada de S3/R2, e a regra não depende de uma regra de borda para ele: **a compensação é o tipo forçado mais o `attachment`, assinados**;
   - o tipo servido é o confirmado pelo servidor, não o declarado.
4. **Validação do SVG.** Na confirmação do envio, o servidor **lê o arquivo** e recusa o SVG que tenha script, manipulador de evento (`on…`), `foreignObject`, referência externa ou `data:`/`javascript:` em endereço; recusado, o objeto é removido, como já é para qualquer tipo recusado. O tamanho tem teto menor que o das fotos.
5. **PDF e áudio** passam pela mesma confirmação do tamanho e do tipo real, contam na cota da agência e são baixados com URL assinada (PDF e áudio **para baixar ou tocar**, nunca renderizados como página do app).
6. **O que a tela mostra.** A tabela do quadro ("Tipo": Foto, PDF, Vídeo, Logo, Áudio) e a pasta contam os arquivos por tipo ("96 fotos", "9 PDFs").

**Substitui.** A decisão [`2026-09-18-tipos-de-midia-aceitos-definidos-em-codigo`](2026-09-18-tipos-de-midia-aceitos-definidos-em-codigo.md): a lista passa a ter PDF, áudio e SVG como logo. Ela segue valendo no resto (a lista é definida em código, e ampliá-la é mudança de código); `specs/conteudo.md` (regra de "só imagem e vídeo") e o fluxo `docs/mobile/fluxos/agencia.md` ("Só imagem e vídeo; outros tipos recebem `415`") são atualizados.

**Consequência.**

- **É estrutural:** altera uma tabela que já existe (a categoria da mídia, que hoje só aceita imagem e vídeo, passa a aceitar os cinco tipos) e muda o contrato de mídia que o conteúdo, o portal e o mobile leem. **Migration** nova (forward-only) que amplia a restrição da categoria e acrescenta o marcador de logo. **Sem backfill.** A mídia que existe continua Foto ou Vídeo.
- **Risco: Alto** (armazenamento e execução de conteúdo do usuário). Pede revisão de segurança independente, com ataque real: um SVG com script, aberto pela URL assinada, pelo painel e pelo download, **não executa**; o SVG nunca aparece num `innerHTML`; um tipo declarado diferente do real é recusado; PDF e áudio não vão a um conteúdo.
- O worker de processamento ignora PDF, áudio e SVG (não há miniatura de vídeo nem dimensões para eles; as dimensões do SVG não são lidas).

**Origem.** Pedido do dono do produto em 2026-11-11 e decisão do maestro de aceitar PDF, áudio e SVG como logo, com a regra de servir o SVG (risco 20 do inventário).

**Validação.** Pendente de validação do dono.
