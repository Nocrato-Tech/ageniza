# A foto do cliente vive no armazenamento de identidade
**Data.** 2026-09-26

**Contexto.** O armazenamento de identidade, decidido em Colaboradores, é separado da mídia, não consome quota e já previa servir a identidade visual de portal.

**Decisão.** A foto do cliente vai para esse armazenamento, não para `media_assets`.

**Consequência.** A foto do cliente **depende da issue #100**, que cria o armazenamento de identidade; isso entra como dependência no recorte deste módulo. Avatar decorativo não disputa quota com vídeo de cliente.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

