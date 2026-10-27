# Contato do cliente é cadastro; acesso ao portal é vínculo, e pode haver vários

**Data.** 2026-09-26

**Contexto.** Na conversa, "o cliente" significava ao mesmo tempo a empresa, o contato do dono e a conta que entra no portal. O sistema já trata o acesso como vínculo por pessoa — `client_memberships` com `unique (client_id, user_id)` —, e nada limitava a um.

**Decisão.** São duas coisas independentes:

- **Dados do cliente** — empresa e contato do dono — são **cadastro**, preenchido pela agência. Existem antes de qualquer convite e continuam existindo se ninguém nunca aceitar.
- **Acesso ao portal** é convite para um e-mail, que vira vínculo quando aceito. O e-mail do convite pode ou não ser o do contato.

Um cliente pode ter **várias pessoas no portal, todas com o mesmo acesso**. Papel dentro do portal fica fora do MVP.

**Consequência.** Nenhuma regra nova de banco para limitar o vínculo. O dado de contato nunca é derivado da conta global de quem aceitou — se fosse, a pessoa o editaria no próprio perfil e a agência perderia o controle do cadastro. Quando o dono quiser passar a aprovação a outra pessoa, a resposta é convidá-la.

**Origem.** Decidido em sessão (entrevista do módulo de clientes). **Substituída em parte em 2026-10-26**, quanto ao acesso ao portal ser um convite que vira vínculo quando aceito: o acesso passa a ser dado a um e-mail, na hora e sem conta, e passa à conta quando ela entra com aquele e-mail verificado (ver a entrada de 2026-10-26 sobre o acesso ao portal por e-mail). O contato como cadastro da agência, nunca derivado da conta, e as várias pessoas com o mesmo acesso continuam valendo.

