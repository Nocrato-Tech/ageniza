# Cliente pode desfazer aprovação antes da publicação

**Validação.** Pendente de validação do dono.

**Origem.** Pedido do usuário em 06/11/2026, issue #850: permitir cancelar uma aprovação no portal mobile.

**Decisão.** Uma pessoa ativa do portal pode desfazer a aprovação de um conteúdo aprovado daquele cliente. A ação pede confirmação e a revisão lida e devolve o conteúdo a aguardando aprovação, sem mudar legenda, mídia, data ou revisão. Vale para todas as pessoas do portal, como a aprovação atual; não depende de quem aprovou primeiro. A nova aprovação continua sendo uma decisão explícita.

Conteúdo publicado, cancelado, em produção ou em ajuste não permite essa ação. A agência somente leitura também recusa. Uma revisão desatualizada é conflito; uma repetição em aguardando aprovação da mesma revisão é sucesso sem outro evento. O vínculo próprio do cliente continua obrigatório mesmo para Owner e colaboradores. Links de aprovação sem conta não ganham esta ação.

**Consequência.** Nova função de banco de escopo único e rota autenticada do portal; sem novas colunas, grants de tabela, alteração de RLS ou backfill. A transição aprovado → aguardando aprovação já existe no gatilho e limpa a aprovação anterior. A função serializa com publicação, edição, arquivamento e remoção de acesso e registra `content.approval_withdrawn` na auditoria na mesma transação. O mobile apresenta confirmação e volta à fila depois da resposta da API.
