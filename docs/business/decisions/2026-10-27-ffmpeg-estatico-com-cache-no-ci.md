# ffmpeg estático com cache no CI

**Data.** 2026-10-27

**Contexto.** O job "PostgreSQL local database" instalava o ffmpeg com `apt-get` no runner, e a lentidão do mirror do apt derrubou o job por tempo (#735). Para sobreviver a isso, o teto do job tinha subido para 35 minutos, enquanto os runs bons levam entre 7,5 e 11 minutos.

**Decisão.** O CI usa o binário estático do ffmpeg 7.0.2 (`ffmpeg` e `ffprobe`), baixado com nova tentativa, conferido por sha256 fixo no workflow e guardado com `actions/cache` por versão. Foi preferido à `cache-apt-pkgs-action` porque não adiciona ação de terceiro nem depende do mirror do apt. O passo tem teto próprio de 5 minutos e o job volta para 20 minutos (cerca do dobro do pior run bom). O `production.yml` não instala o ffmpeg e não muda. Subir a versão exige trocar a URL, o sha256 e a chave do cache juntos.

**Consequência.** Com o cache quente, o passo só restaura e confere a versão. Sem cache, depende do host do binário estático, e o sha256 impede que um arquivo trocado entre no CI.

**Origem.** Issue #735.

**Validação.** Pendente de validação do dono.
