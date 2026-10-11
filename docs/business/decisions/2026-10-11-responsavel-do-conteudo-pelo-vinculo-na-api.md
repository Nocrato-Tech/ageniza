# O responsável do conteúdo é dito pelo vínculo com a agência, nunca pelo id de usuário

**Data.** 2026-10-11

**Contexto.** O conteúdo (#254) devolvia e recebia `ownerUserId`, mas o contrato de colaboradores esconde de propósito o id de usuário dos outros e só traz `membershipId`. A tela não consegue mostrar o nome do responsável (o hover do calendário, #262) nem escolher um responsável (a aba Atribuição, #265): ela não tem o id de usuário que a API pede. Achado da Âncora no PR B da #262, issue #552, com a decisão do maestro que a issue registra.

**Decisão.**

1. **O que a API devolve.** A lista do período, o detalhe e o que cada transição devolve trazem `owner: { membershipId, name }`, no lugar de `ownerUserId`. O `membershipId` é o vínculo da pessoa com a agência do cliente; o `name` é o da conta desse vínculo, como o portal mostra as pessoas. Um vínculo removido continua nomeando quem era o responsável (o conteúdo foi dele). `owner` é `null` para quem não tem vínculo com a agência: o Owner que a tem só por posse (`agencies.owner_user_id`) e criou o conteúdo sem escolher outro.
2. **O que a API recebe.** `PATCH` aceita `ownerMembershipId` e não aceita mais `ownerUserId` (o corpo é `.strict()`, então o campo antigo é `400`). O vínculo precisa ser um vínculo **ativo de colaborador da mesma agência**, que veja Conteúdo; um vínculo removido, de outra agência, do portal de um cliente, que não existe ou de quem não vê Conteúdo é `400 CONTENT_OWNER_INVALID`, nunca `500`. A regra do banco continua sendo a segunda barreira (`A0073`).
3. **A permissão não muda.** Trocar o responsável continua exigindo `conteudo.aprovar_pela_agencia`, e quem não a tem leva `403` **qualquer que seja o vínculo**, para que a resposta nunca diga se um vínculo é ativo. Mandar o vínculo do próprio responsável atual não é troca e não pede a permissão. Cliente arquivado responde `409` antes de olhar o vínculo.
4. **A criação segue a edição.** `POST` do conteúdo troca `ownerUserId` por `ownerMembershipId`, com as mesmas regras e sem a permissão de aprovar (quem cria escolhe, como já era). A issue fala do `PATCH`; a criação entra porque a tela que cria não tem outro id para mandar, e deixá-la com `ownerUserId` manteria a rota expondo o que se quer esconder.
5. **Nenhuma rota de conteúdo devolve o id de usuário do responsável.** Esta decisão trata só o responsável. Os outros ids de usuário que o detalhe ainda traz (`approvedBy`, e `assigneeUserId` e `approvedBy` das subtarefas) não são decididos aqui: `approvedBy` pode ser uma pessoa do portal, que não tem vínculo com a agência, e as subtarefas são da #255.

**Alternativas fechadas.** Expor o `userId` de colaborador no contrato de colaboradores: foi escondido de propósito. Devolver só o `membershipId`, sem nome: a tela voltaria a pedir a lista de colaboradores para cada cartão do calendário.

**Consequência.**

- Muda o formato de resposta que as rotas de conteúdo copiam (e que Tarefas e Dashboard vão copiar): `owner` no lugar de `ownerUserId` em `ContentListItem` e em `Content`. Nenhuma migration, tabela, coluna ou grant.
- Quem lê nome e vínculo passa por `agency_memberships` (qualquer membro da agência lê os vínculos dela) e por `auth."user"`, que já é lido assim pelos colaboradores.
- O PR depende do #555, que cria as seis rotas de transição que devolvem o mesmo detalhe.

**Origem.** Issue #552, achado da Âncora no PR B da #262; decisão do maestro registrada na issue.

**Validação.** Pendente de validação do dono.
