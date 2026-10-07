# Mídia vai direto do navegador para o armazenamento

**Data.** 2026-09-16

**Contexto.** O produto gerencia vídeo longo e Reels em volume. Passar os arquivos pelo servidor esbarraria no limite de 100 MB da borda e encheria o disco da VPS.

**Decisão.** O upload vai direto do navegador para o R2, com URL assinada e multipart retomável. O servidor autoriza antes e, depois, confere o que de fato chegou. Arquivo fora do tipo, do tamanho ou da quota é recusado e apagado.

**Consequência.** A validação só é possível **depois** do upload, porque o protocolo não aceita política de tamanho em URL assinada. CORS e lifecycle do bucket são configuração manual no painel da Cloudflare, e é o único trecho do fluxo sem cobertura de teste automatizado.

**Origem.** Issue #21, ADR 0011.

