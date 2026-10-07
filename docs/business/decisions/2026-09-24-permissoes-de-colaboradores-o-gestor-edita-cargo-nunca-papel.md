# Permissões de colaboradores: o Gestor edita cargo, nunca papel
**Data.** 2026-09-24

**Contexto.** Faltava definir o que separa o Admin do Gestor de conta. O modelo não tem hierarquia entre colaboradores — `ClientAssignment` liga colaborador a cliente, nunca colaborador a colaborador —, então qualquer poder administrativo do Gestor é poder sobre **todos**, inclusive sobre Admins.

**Decisão.** O catálogo do módulo:

| capacidade | permissão | quem recebe no preset |
|---|---|---|
| Ver a equipe | `colaborador.visualizar` | todos os cinco papéis |
| Convidar | `colaborador.convidar` *(já existe)* | Admin |
| Reenviar e cancelar convite | `convite.reenviar` · `convite.cancelar` *(já existem)* | Admin |
| Remover do quadro | `colaborador.remover` | Admin |
| Trocar o papel de outro | `colaborador.alterar_papel` | Admin |
| Editar o cargo de outro | `colaborador.alterar_funcao` | Admin e **Gestor de conta** |

**Não existe `colaborador.operar`.** A decisão da sessão 0 obriga `visualizar` em todo módulo, mas não obriga `operar`, e aqui não há uso entre olhar a equipe e administrar alguém. Editar o próprio perfil não é permissão: é sobre si, e se resolve por identidade.

A distinção que sustenta o Gestor: **cargo é dado profissional e não concede autorização; papel concede.** Ele organiza a equipe sem poder aumentar o acesso de ninguém. E ele **não convida**, porque convidar obriga a escolher o papel, e os cinco presets **não têm ordem entre si** — sem hierarquia de papéis, nada impediria um Gestor de convidar alguém como Admin e pedir para ser promovido de volta.

**Consequência.** "Gestor de operação", "gestor financeiro" e "gestor de vendas" são **cargos**, não papéis: o papel `account_manager` é um só, e o que diferencia um do outro é o `job_title` mais as permissões que os outros módulos derem a ele. Ninguém deve criar três papéis onde um basta.

**Origem.** Decidido em sessão (entrevista do módulo de colaboradores).

