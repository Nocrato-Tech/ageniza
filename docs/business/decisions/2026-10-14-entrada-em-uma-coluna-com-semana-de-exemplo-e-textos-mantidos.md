# Entrada em uma coluna, com a semana de exemplo ao lado e os textos de hoje mantidos

**Data.** 2026-10-14

**Contexto.** A artboard Login do canvas da Pauta está desenhada no escuro, com o texto "E-mail ou senha não conferem. Confira os dois ou use "Esqueci minha senha"." e a frase "É cliente de uma agência? Entre pelo link que chegou no seu e-mail.". A decisão de 2026-10-14 (área da agência sempre escura; entrada sempre clara) manda a entrada para o claro, e os testes das telas de entrada fixam os textos que existem hoje. A #629 muda só o visual.

**Decisão.**
1. Login, esqueci a senha, redefinir senha, convite e confirmação de troca de e-mail dividem um mesmo quadro: logo completo para fundo claro no topo, uma coluna, links de Termos de uso e Privacidade no rodapé. Em tela de 64rem ou mais, uma semana de exemplo (cliente e datas inventados, marcada "exemplo", escondida de leitor de tela) aparece ao lado; abaixo disso ela não aparece.
2. Os textos de hoje ficam: "E-mail ou senha incorretos." (mensagem única para senha errada e e-mail desconhecido) e "O acesso ao Ageniza é por convite.". Os textos da artboard que divergem deles não entram, e a frase sobre cliente e link por e-mail não entra porque diz uma regra de acesso do portal que esta tarefa não decide.
3. O título da tela de login passa de "Ageniza" para "Entrar", com a frase "A pauta da sua agência está te esperando." da artboard.
4. A semana de exemplo não usa as capas coloridas da artboard (cores fora da paleta): cada cartão usa o tom do formato e o ícone do estado dos tokens da Pauta. Quando os componentes de domínio da #625 existirem, a semana passa a usá-los.

**Consequência.** Nenhuma regra, rota ou dado muda. A troca para os componentes da #625 (ButtonLink, etiquetas de formato e estado) fica anotada no PR. O dono pode pedir a frase da artboard sobre cliente depois, como decisão própria.

**Origem.** Issue #629, épico #621.

**Validação.** Pendente de validação do dono.
