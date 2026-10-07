# Foto de perfil vive em armazenamento de identidade, separado do módulo de mídia

**Data.** 2026-09-24

**Contexto.** `auth."user".image` já existe, mas não há fluxo de upload. E há um conflito de escopo: o **usuário é global** e a **mídia é por agência, com quota**. A foto de quem trabalha em duas agências não pertence a nenhuma delas.

**Decisão.** Existe um **armazenamento de identidade**, separado do módulo de mídia e **sem consumir quota de agência**. Ele serve a foto de usuário hoje e a identidade visual de portal depois, quando a personalização por agência existir.

**Consequência.** É infraestrutura nova neste módulo — a primeira desde a mídia. O que se evita é um defeito verificável: com a foto dentro da mídia da agência, a pessoa sai daquela agência ou a agência é suspensa, e o avatar dela desaparece nas outras, porque o arquivo pertencia ao tenant e não a ela. A quota de vídeo de cliente também deixa de disputar espaço com avatar, que é uso decorativo.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

