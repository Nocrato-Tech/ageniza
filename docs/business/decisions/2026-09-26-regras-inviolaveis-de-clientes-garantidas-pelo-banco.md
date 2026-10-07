# Regras invioláveis de clientes, garantidas pelo banco

**Data.** 2026-09-26

**Contexto.** O módulo abre a primeira superfície em que uma pessoa de fora da agência — o cliente — lê e escreve. Regra que vive só na rota é furada pela primeira rota nova que a esquecer, e Conteúdo vai criar várias.

**Decisão.** Garantidas pela RLS, por *grant* ou por índice, não apenas pela API:

1. Pessoa do portal **nunca lê nada de outro cliente**, nem da mesma agência — cadastro, estudo, personas e threads.
2. Colaborador **sem vínculo de cliente não entra no portal**, nem Admin nem Owner.
3. Pessoa do portal **nunca escreve no estudo de marca nem nas personas**; só comenta, e só nas threads do próprio cliente.
4. **Comentário não tem `UPDATE` nem `DELETE`** para o papel da aplicação.
5. **Cliente arquivado não aceita escrita** — cadastro, estudo, personas, threads e convites. A policy confere o status.
6. **Nome único entre os ativos da agência**, por índice único parcial sem diferenciar maiúsculas; nunca por consulta prévia, que perde para a concorrência.
7. **Só a agência resolve thread**: a policy exige `cliente.operar`, que vínculo de cliente nunca satisfaz.
8. **Não existe thread interna.** Toda thread do estudo é conversa com o cliente. Uma marca de "interna" numa tabela que o portal lê é o vazamento mais provável do módulo; discussão interna acontece fora, ou em Tarefas quando existir.

E duas regras de comportamento:

- **Reativar um cliente cujo nome já está em uso entre os ativos é recusado**, com mensagem clara; alguém renomeia um dos dois antes. Renomear sozinho mudaria um dado que o cliente vê no portal sem a agência perceber.
- **O portal lê o próprio cadastro**, somente leitura — `clients_select` já entrega a linha inteira ao vínculo de cliente.

**Consequência.** Pela última regra, **nenhum campo interno da agência sobre o cliente** — nota, avaliação, risco de churn — pode morar em `clients`. Se existir um dia, nasce em tabela própria que o portal não alcança. Cada item numerado vira teste de integração contra o banco.

**Origem.** Decidido em sessão (entrevista do módulo de clientes).

