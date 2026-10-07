# Checklist obrigatório antes de abrir ou atualizar um PR

**Data.** 2026-10-06

**Contexto.** As revisões de código e de segurança repetem os mesmos achados entre implementadores de vários modelos: teste que continua verde sem a regra que deveria proteger, cenário que a RLS escondeu a falta do filtro, mudança de contrato que mescla limpo e quebra em runtime, aceite do tipo "não acontece" sem checagem automatizada.

**Decisão.** Antes de abrir ou atualizar um PR, o implementador passa por `docs/implementation-checklist.md`, e o corpo do PR lista a mutação que prova cada item de aceite. Cada item do checklist nasceu de um achado real de revisão, com os PRs de origem citados ao lado.

**Consequência.** Um teste que continua verde sem a regra que deveria proteger vira achado de revisão e, se voltar a se repetir, entra para o checklist. O checklist não substitui `docs/security-review.md` nem as notas do projeto — só lista o que mais se repete.

**Origem.** Pedido do dono do produto, em 2026-10-06.

