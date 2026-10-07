# O modal do próprio perfil mostra a data de entrada, como o wireframe

**Data.** 2026-10-07

**Contexto.** A §7 de `specs/colaboradores.md` desenha "Na agência desde <data>" no cabeçalho do modal, sem exceção, e o ramo do próprio perfil só mostrava a foto e a nota de que a foto é global (issue #357, achado da auditoria de fechamento do módulo).

**Decisão.** A data de entrada aparece também no modal do próprio perfil: não há motivo para esconder da pessoa a própria data de entrada, e a tela passa a seguir o wireframe sem exceção.

**Consequência.** O ramo do próprio perfil ganha a linha da data, que já vinha no item da API; um teste novo cobre o próprio perfil e fica vermelho se a linha sair. Nenhum contrato, rota ou dado muda.

**Origem.** Issue #357, decisão do maestro com autonomia dada pelo dono do produto em 2026-10-07. **Pendente de validação** pelo dono do produto.

