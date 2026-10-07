# Desenvolvimento e validação locais até os módulos iniciais ficarem prontos
**Data.** 2026-09-23

**Contexto.** A infraestrutura está escrita e com CI verde, mas nunca rodou num deploy real. A alternativa era contratar a VPS agora, ou ao menos apontar um Cloudflare Tunnel gratuito para a máquina de desenvolvimento e exercitar o R2 real antes de seguir. Nenhuma das duas era necessária para continuar construindo.

**Decisão.** Todo o desenvolvimento e toda a validação seguem locais — PostgreSQL, MinIO, Mailpit e worker em Docker — até que os módulos iniciais estejam prontos. Só então vem o deploy e a validação contra os serviços reais.

**Consequência.** Estes pontos ficam **sem validação alguma** até lá, e os ajustes que eles exigirem virão todos de uma vez:

- CORS e lifecycle do bucket R2. O MinIO não implementa a API de CORS por bucket, e sem o header `ETag` exposto o upload multipart não funciona.
- Comportamento real do R2 em multipart e URLs assinadas, onde o MinIO não é substituto fiel.
- Cloudflare Tunnel como única borda pública.
- Entrega real de e-mail: SPF, DKIM e reputação. O Mailpit não prova nada disso.
- Consumo de CPU do ffmpeg disputando a VPS com o PostgreSQL e a API, que é a premissa por trás dos limites de concorrência escolhidos.
- Backup e restore de verdade contra o R2.

Para reduzir o risco, o deploy deve ser feito **antes** de haver dependência dele: a primeira validação real vai gerar ajustes, e é melhor que aconteçam numa semana tranquila.

**Origem.** Decidido em sessão.

