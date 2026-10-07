# Idioma: código em inglês, documentação de negócio em português

**Data.** 2026-09-24

**Contexto.** O repositório já misturava os dois sem regra escrita: código, identificadores e comentários em inglês; `docs/business/` e as SPECs em português; mensagens ao usuário em português. Os commits eram em inglês com escopo (`feat(api):`) até 23/09 e passaram a português sem escopo a partir da sessão seguinte — mudança feita sem registro, e percebida só na auditoria de documentação.

**Decisão.** **Código em inglês**: identificadores, comentários, nomes de arquivo, schemas e mensagens de log. **Documentação de negócio em português**: `docs/business/`, `specs/`, `README` de módulo, issues. **Mensagem ao usuário em português**, inclusive as da API, que já respondem assim.

O **commit segue o idioma do que ele muda**. Um commit que mistura código e documentação de negócio é sinal de que deveriam ser dois commits.

Junto com isso, o `AGENTS.md` já exigia comentário mínimo, e a regra continua valendo com ênfase: comentário existe para o que o código não consegue dizer — uma restrição não óbvia, a razão de uma decisão surpreendente. Nunca para repetir o que a próxima linha faz.

**Consequência.** O histórico de commits fica bilíngue, e converter o passado não vale o esforço: a regra passa a valer daqui em diante. Quem escreve código lê e escreve inglês de qualquer forma, porque é o idioma das bibliotecas; quem decide produto lê português, e é para essa pessoa que `docs/business/` existe.

**Origem.** Decidido em sessão, durante a auditoria de documentação para entrada de novos desenvolvedores.

