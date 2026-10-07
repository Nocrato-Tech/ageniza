# Preset de clientes: o Gestor opera e cadastra, só o Admin arquiva e gerencia o portal

**Data.** 2026-09-26

**Contexto.** A linha de preset do módulo é obrigatória na SPEC. O ponto sensível era o acesso ao portal: dar ao Gestor de conta as permissões de convite de cliente daria a ele, pelas policies atuais, leitura e cancelamento de convites de colaborador.

**Decisão.**

| permissão | Admin | Gestor de conta | Produção | Vendas | Financeiro |
|---|---|---|---|---|---|
| `cliente.visualizar` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cliente.operar` | ✅ | ✅ | — | — | — |
| `cliente.cadastrar` | ✅ | ✅ | — | — | — |
| `cliente.arquivar` | ✅ | — | — | — | — |
| `cliente.convidar_usuario` | ✅ | — | — | — | — |
| `cliente.remover_usuario` | ✅ | — | — | — | — |

Produção lê o estudo de marca para trabalhar, mas não o edita nem responde o cliente. Vendas não cadastra: quem cadastra é quem vai atender. Arquivar corta o portal na requisição seguinte — é fim de contrato, e fica com o Admin.

**Consequência.** As permissões de convite continuam compartilhadas entre os dois tipos, e nada estrutural acontece agora. Separá-las por tipo reescreve as policies de `insert`, `update` e `select` de `invitations` — **estrutural**, por atravessar RLS de outro módulo. Gatilho: **o primeiro Gestor precisar convidar pessoa de cliente sem o Admin**. Vendas volta à mesa quando Pipeline entrar.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

