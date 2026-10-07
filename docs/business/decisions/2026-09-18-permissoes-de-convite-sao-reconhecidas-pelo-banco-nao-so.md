# Permissões de convite são reconhecidas pelo banco, não só pela API
**Data.** 2026-09-18

**Contexto.** As policies do banco exigiam a permissão de *convidar* para qualquer alteração em convites, enquanto as rotas de reenviar e cancelar exigem as suas próprias. Um papel com apenas `convite.cancelar` passaria pela API e veria zero linhas.

**Decisão.** Alinhar o banco às rotas: as policies aceitam qualquer permissão que governe a operação. Nenhuma permissão nova foi criada.

**Consequência.** Como `admin` já detém as quatro, o comportamento hoje é idêntico; a mudança só importa quando existirem papéis personalizados. Reenviar cria uma linha nova, então a policy de inserção também reconhece `convite.reenviar` — e com isso o RLS deixa de garantir sozinho que apenas quem convida cria convite. A API mantém essa fronteira.

**Origem.** Issue #39, PR #41.

