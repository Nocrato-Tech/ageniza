# Ícone 3D no palco, só em pontos de ênfase

**Data.** 2026-11-11

**Contexto.** O quadro do redesenho de 2026-11-11 pede um toque de personalidade nos momentos que importam (um resumo, a jornada, um marco, uma pasta, um vazio). O conjunto de ícones da interface é o `lucide`, de traço fino, que não carrega esse peso. Foi preciso escolher uma fonte de ícones 3D com licença que permita o uso comercial.

**Decisão.**

1. **Fonte e licença.** [3dicons](https://3dicons.co), de realvjy e colaboradores, sob **CC0 1.0** (domínio público, uso pessoal e comercial, sem atribuição). Usa-se o estilo `color`, ângulo `dynamic`; os arquivos ficam no repositório com o texto da licença ao lado.
2. **Onde entra.** Só em pontos de ênfase: o resumo, a jornada, os marcos, as pastas e os estados vazios, **inclusive os do portal**. Ação e navegação continuam com o `lucide`. Um ícone 3D por bloco, nunca em linha de lista, botão, aba ou tabela.
3. **Como entra.** Sobre um **palco**: o render vai como vem, sem pintura, filtro ou tinta, apoiado num disco no tom da família do cartão, com sombra de contato e uma flutuação lenta. Com ponteiro que paira, inclina-se na direção dele; no toque e para quem pede menos movimento, fica parado.
4. **Acessibilidade.** É decorativo: fora da árvore de acessibilidade, com texto alternativo vazio. O título ao lado diz tudo; o ícone nunca é o único sinal de nada.

**Consequência.**

- O componente é `Stage3D`, em `packages/ui`; a regra de uso mora em `docs/design-system.md`.
- O mascote (a coruja) continua sendo a figura de marca dos vazios e dos erros de página inteira; o palco 3D não o substitui sem uma decisão própria.

**Origem.** O dono do produto, ao aprovar o quadro do redesenho em 2026-11-11.

**Validação.** Pendente de validação do dono.
