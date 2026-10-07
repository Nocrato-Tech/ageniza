# Cliente na mídia fica para Conteúdo, com diagnóstico mais grave que o registrado
**Data.** 2026-09-26

**Contexto.** A estrutural conhecida dizia que `media_assets` é escopado só por agência. A leitura das policies mostra mais: o `SELECT` de `media_assets` exige `midia.enviar`, então **o portal não vê mídia nenhuma**, nem a própria. E Clientes não usa `media_assets` — a foto do cliente vai para o armazenamento de identidade.

**Decisão.** A estrutural continua **pendente** e é decidida no **bloco de impacto estrutural da entrevista de Conteúdo**, que é o gatilho. A forma — cliente por arquivo, por pasta ou pelo conteúdo que usa o arquivo — depende do modelo de pastas que só Conteúdo vai desenhar.

**Consequência.** Qualquer que seja a forma, ela terá de dar ao vínculo de cliente leitura sobre mídia, que hoje nenhuma policy concede — é migration mais RLS nova, e continua estrutural.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

