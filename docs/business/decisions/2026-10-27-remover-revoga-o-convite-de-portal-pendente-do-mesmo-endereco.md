# Remover revoga o convite de portal pendente do mesmo endereço

**Data.** 2026-10-27

**Contexto.** Os convites de portal pendentes continuam aceitáveis até vencer (decisão de 2026-10-26, item 7). Com "Adicionar pessoa" e "Remover", o caminho convite pendente, Adicionar, Remover e aceite do convite velho devolvia o acesso a quem a agência tinha removido (achado 1 da revisão do PR #728).

**Decisão.**

1. Remover um acesso **revoga**, na mesma transação, os convites de portal (`client_invite`) pendentes do mesmo cliente e do mesmo e-mail. Cada um gera o evento `invitation.revoked`. Vale em agência somente leitura, porque remover reduz acesso.
2. Como segunda barreira, a função que grava o acesso a partir de um convite **recusa** (`A0001`, link inválido) quando a linha daquele e-mail está removida, seja qual for o convite. Convite antigo nunca desfaz uma remoção; quem volta é pelo Adicionar pessoa.

**Consequência.** Substitui o caso "o removido que aceita convite pendente recupera o mesmo vínculo". Reativar pelo id continua sendo a volta da agência. Não muda tabela.

**Origem.** Revisão de segurança do PR #728 (achado 1, Média).

**Validação.** Pendente de validação do dono.
