# A foto do cliente herda a #100 e fecha três lacunas que a SPEC não cobria

**Data.** 2026-10-06

**Contexto.** A task #126 manda reutilizar transporte, limites e nome de objeto da foto de perfil (#100/#101). Ao reutilizar, apareceram três pontos que nem a SPEC de clientes nem a #100 decidem: o que fazer quando o cliente é arquivado entre a checagem e o commit, o que impede que uma referência `photo_key` adulterada vire um `DELETE` em objeto alheio, e se a rota de envio tem teto por conta.

**Decisão.**
- **Pré-checagem antes do bucket.** `PUT` consulta o cliente (404 indistinto ou 409 `CLIENT_ARCHIVED`) **antes** de gravar o objeto. Se o arquivamento vencer a corrida e o commit achar o cliente arquivado, o objeto recém-gravado é removido e a resposta é a mesma 409.
- **Só se apaga o que é do cliente.** O objeto anterior só é apagado quando a chave ainda está em `agencies/<agência>/clients/<cliente>/avatar/`; qualquer outra referência é registrada em `warn` e deixada intacta. A referência é dado numa tabela, e a coluna `photo_key` está no grant de `INSERT` e `UPDATE` do papel da aplicação.
- **Teto por usuário no `PUT`**: 30 por minuto, o mesmo número do perfil, porque o armazenamento de identidade não tem quota.
- Respostas: `{ photoUrl }` no `PUT`, `204` no `DELETE` (idempotente), `413` para imagem acima do teto e `415` para tipo fora da lista, como no perfil.

**Consequência.** Nenhuma migration, nenhuma policy, nenhum formato de resposta que outras rotas copiem além do `{ photoUrl }` já previsto na issue. A listagem (#125) e o portal (#129) devem assinar `photo_key` como o detalhe faz, e quem implementar uma foto de outro dono (agência, portal) deve copiar a checagem de diretório antes de apagar.

**Origem.** Issue #126. **Pendente de validação** pelo dono do produto: o número do teto foi mantido do perfil porque a SPEC não o define.

