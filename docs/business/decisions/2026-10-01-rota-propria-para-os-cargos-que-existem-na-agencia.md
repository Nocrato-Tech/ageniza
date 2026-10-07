# Rota própria para os cargos que existem na agência

**Data.** 2026-10-01

**Contexto.** `specs/colaboradores.md` (linha 190) diz que o filtro de cargo "lista os valores que existem naquela agência", mas nenhuma rota da seção 6 devolvia essa lista: a listagem paginada (#95) traz só uma página, e o formato dela é o que as próximas listagens vão copiar. A lacuna apareceu ao preparar a grade de crachás (#102).

**Decisão.** Uma rota própria e mínima, `GET /agencies/:agencyId/collaborators/job-titles`, com as mesmas guardas da listagem (`requireAgencyAccess` + `requirePermission('colaborador.visualizar')`). A resposta é `{ data: string[] }` com os cargos **distintos** dos vínculos **ativos** da agência — aparados com `btrim`, sem nulos e sem vazios —, em ordem alfabética e no máximo 200 valores. A consulta parte de `agency_memberships` filtrada pela agência da rota. O formato da listagem paginada não muda.

**Consequência.** O filtro de cargo da grade tem fonte própria, sem alterar o formato de resposta que outras rotas já usam. Rota aditiva: nenhuma migration, nenhuma policy nova, nenhum campo novo em contrato existente. Como é um caminho novo de leitura da agência, entra com a mesma barreira de escopo da listagem (a RLS mostra as agências do chamador, nunca uma só; o filtro de agência da consulta é a barreira que separa).

**Origem.** Issue #218, decidida pelo maestro a partir da lacuna achada na #102. **Pendente de validação** pelo dono do produto.

