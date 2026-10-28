# O Path do cookie do link de aprovação vem do endereço público da API

**Data.** 2026-10-27

**Contexto.** A decisão de 2026-10-27 sobre o link de aprovação (sessão de duas horas, limites e o que a página lê) restringe o cookie `ageniza_approval` às rotas do link e escolhia o `Path` por `environment === 'production'`: `/api/portal-approval` em produção, `/portal-approval` nos demais. O navegador só devolve o cookie ao caminho que ele vê, que é o do endereço público da API (em produção, o contêiner web repassa `/api` e a API responde sem esse prefixo), e esse endereço é o `VITE_API_BASE_URL` do build do web. Deduzi-lo do ambiente falha fechado quando os dois divergem (a Garça apontou na revisão do #740), e o próprio cliente HTTP do web descartava o caminho do `VITE_API_BASE_URL` (issue #737), de modo que `https://<domínio>/api` nunca funcionou como documentado.

**Decisão.**

1. O cliente HTTP do web **mantém o caminho base** de `VITE_API_BASE_URL`, com ou sem `/` no fim, para toda requisição e para a navegação do Google, por uma regra só. Continuam valendo a mesma origem, nenhum segmento relativo ou vazio, nenhum separador em qualquer codificação, e agora também nenhuma fuga do caminho base. Uma base com consulta, fragmento ou segmento vazio é recusada.
2. A API ganha `API_PUBLIC_URL`, **o endereço em que o navegador chega à API, caminho incluso**. O `Path` do cookie é o caminho dele mais `/portal-approval`, e `Secure` segue o esquema dele. Padrão, quando vazio: `APP_PUBLIC_URL` + `/api`, a topologia de produção (como o `GOOGLE_CALLBACK_URL`). Localmente a API tem a própria origem, e o `.env.example` e o `compose.yml` informam `http://127.0.0.1:3001`. Deve ser o mesmo valor que `VITE_API_BASE_URL` (`PRODUCTION_VITE_API_BASE_URL`, em produção). Sem credenciais, consulta ou fragmento, HTTPS fora de loopback em produção, e o caminho só aceita segmentos de `[A-Za-z0-9._~-]`: o caminho é escrito num atributo `Path=`, e um `;` ou uma `,` o terminaria antes (`https://domínio/;` virava `Path=/;/portal-approval`, lido pelo navegador como `Path=/`), enquanto espaço, aspas e `%` não são lidos como o caminho. Qualquer outro caractere é recusado na subida da API.

**Consequência.** Variável nova, documentada em `local-environment.md`, `production-deploy.md`, `.env.example` e `runtime.env.example`, e permitida no `ageniza-deploy.sh`. Um `.env` local antigo sem a variável cai no padrão de produção e o cookie do link deixa de voltar até a linha ser acrescentada. A produção ainda não foi lançada (a lista de prontidão está toda aberta e não há execução do fluxo de produção), então o defeito do cliente HTTP não chegou ao ar: o valor documentado, `https://<domínio>/api`, o dispararia no lançamento.

**Origem.** Issue #737 (achado da Âncora no #736) e a revisão do #740 pela Garça.

**Validação.** Pendente de validação do dono.
