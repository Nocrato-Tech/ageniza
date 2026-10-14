# O realce (índigo cheio) tem quatro usos, incluindo o cliente selecionado

**Data.** 2026-10-14

**Contexto.** O goal da Pauta limitava o índigo cheio a três usos: a ação primária, o dia de hoje e o que está na vez de quem olha. O `ClientStrip` (#625) marca o cliente aberto com `aria-current`, uma superfície e o `Realce` no nome; a revisão do #655 apontou que isso contradizia a regra escrita. A alternativa só com superfície (`bg/hover`) dá 1,03:1 sobre o canvas no tema claro, e o selecionado some.

**Decisão.**
1. O índigo cheio (`action/primary/bg` e o `Realce`) tem quatro usos e só eles: a ação primária, o hoje, a vez de quem olha e o cliente selecionado no seletor de clientes (`ClientStrip`).
2. O aceite visual comum das telas passa a ler "índigo cheio só em ação, hoje, sua vez e cliente selecionado".
3. Duas manchas de índigo cheio competindo na mesma tela, fora destes usos, continuam sendo erro de revisão.

**Consequência.** O comentário do `Realce`, o do `Pill` e a seção 13 de `docs/design-system.md` listam os quatro usos; a seção 25 do documento traz a regra completa. Tela nova que queira índigo cheio para outra coisa pede uma decisão nova.

**Origem.** Comentário do dono no épico #621 em 2026-10-14; revisão da Lupa no #655.

**Validação.** Pendente de validação do dono.
