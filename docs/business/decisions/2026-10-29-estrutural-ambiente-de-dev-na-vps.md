# ESTRUTURAL: só o dev sobe na VPS por enquanto, publicado a cada merge no develop

**Data.** 2026-10-29

**Contexto.** Até aqui o `develop` era só integração, sem ambiente remoto, e a VPS (Hostinger KVM 2, 2 vCPU, 8 GB, 100 GB, Ubuntu 26.04, já com o bootstrap do #765) esperava a primeira agência-piloto. Sem um ambiente remoto, ninguém além de quem roda a stack local vê o produto, e o fluxo de convite, aprovação e e-mail não é exercitado fora da máquina de quem o escreveu.

**Decisão.** Agora só o dev sobe na VPS. Ele é publicado de forma automática a cada merge no `develop`. A produção entra na mesma VPS na primeira agência-piloto e vai para uma VPS própria quando houver clientes pagando. Por isso o dev tem limite de CPU e de memória, para nunca afetar a produção. O dev é um ambiente à parte da produção: projeto Compose, rede, volumes, Postgres, conta de deploy, chave, túnel e hostnames próprios. A entrada é por Cloudflare Tunnel, com `dev.ageniza.com.br` para o app e a API e o Mailpit do dev atrás do Cloudflare Access, liberado só para o e-mail do dono. O e-mail do dev só vai para o Mailpit, nunca para um SMTP real. O provedor de pagamento do dev é o simulado (`PAYMENTS_PROVIDER=simulado`, criado por outra frente).

**Consequência.** A frase "não há ambiente remoto no `develop`" do guia de CI e do runbook de deploy deixa de valer; a regra de produção continua a mesma (só `main`, por promoção). O ADR 0013 descreve o desenho; o runbook `docs/infra/dev-environment.md` traz o passo a passo do dono (Registro.br, Cloudflare, tunnel, Access) e a lista de secrets. Domínio e conta da Cloudflare ainda não existem: o primeiro deploy espera o dono criá-los. A produção na mesma VPS passa a depender dos limites do dev, que somam no máximo cerca de 1 vCPU e 3 GB para o dev inteiro.

**Origem.** Decisão do dono em 2026-10-29, na abertura da frente "ambiente de dev na VPS" (issue #774).

**Validação.** Validada pelo dono em 2026-10-29.
