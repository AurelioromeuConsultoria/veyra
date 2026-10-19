---
name: create-vertical
description: Create or extend a vertical product (e.g. Veyra Clinics) on top of the Core — extension tables, own entities, the six ADR-047 composition points, activation lifecycle, data classification and content restriction. The Core must never learn about the vertical.
---

# create-vertical

Referências: `docs/ARCHITECTURE.md §6`, ADR-015, **ADR-047** (contrato de extensão), **ADR-048** (Clinics: domínio, classificação de dados, restrição). O raciocínio completo mora nos ADRs; aqui fica só o checklist.

## Passos

1. **Cheque a direção da dependência.** O vertical importa services e contratos do Core; o Core **nunca** importa, referencia ou "prevê" o vertical. Só a raiz de composição (`app.module.ts`, raiz de rotas e navegação do web) importa `verticals/`, e isso é garantido por lint e por teste de fronteira. Se a feature exige mudar o Core, a mudança precisa ser universal, sem nome de vertical, e passa pelo `architect` com ADR.
2. **Use só os seis pontos do ADR-047** (E1 modelos, E2 permissões e disponibilidade, E3 ativação e papéis, E4 auditoria, E5 navegação, E6 restrição de conteúdo). Precisou de um sétimo? Isso é ADR novo, nunca um gancho genérico. Não crie registro de plugins.
3. **Classifique cada dado** como C, P ou S (ADR-048 §6). Na dúvida, vale a classe mais restrita. Dado S:
   - só existe em tabela do vertical, sob permissões próprias;
   - **nunca** é escrito em entidade do Core (título de tarefa, deal, nota, mensagem, notificação, `Activity`);
   - não tem texto livre nem arquivo sem ADR próprio.
4. **Escolha o mecanismo**, nesta ordem:
   - **Custom fields** do Core: atributo simples, e **nunca** para dado S (custom field herda as permissões do contato).
   - **Extension table 1:1**: `ClinicsPatient(workspaceId, contactId)` com `@@unique([workspaceId, contactId])` e **FK composta** para `Contact(workspaceId, id)`.
   - **Entidade própria**: mesmas convenções do Core. Se tem invariante que o banco precisa garantir (sobreposição, saldo), é dona do dado e não especializa entidade genérica do Core.
5. **Schema e migration**: arquivo de schema próprio no mesmo banco; modelo novo entra no conjunto composto (E1) no mesmo commit. FK do vertical para entidade do Core: pense na **exclusão do Core**. O Core não chama o vertical, então a ação da FK decide o que acontece. `SET NULL` em FK composta exige lista de colunas (`SET NULL ("xId")`, SQL manual), senão anula o `workspaceId`. Invariante que o Prisma não declara (por exemplo `EXCLUDE USING gist` contra sobreposição) vai em SQL manual na migration, com teste de drift do zero. A violação (`23P01`) chega como P2039 e o filtro global a responde com 409 (ADR-048 adendo 1). O arquivo de schema do Core só ganha o **lado reverso** da relação (lista ou opcional, sem `fields:`), conforme o adendo 2 do ADR-047, item 1, guardado por `prisma/core-schema-boundary.spec.ts`.
6. **Permissões**: catálogo próprio com prefixo do vertical; nunca no `PERMISSION_CATALOG` do Core (o Owner receberia tudo em todo workspace). Concessão **só** pela CLI de ativação, **por `systemKey`**, e só onde o vertical está ativo (porta de disponibilidade). Separe leitura de agenda e de atendimento quando o dado S tiver públicos diferentes. Rotas que tocam duas famílias declaram ambas. Sem a chave, a rota responde 403 pelo guard global. O guard de ativação do vertical só dá 404 no caso residual de chave presente com o vertical desativado (adendo 2, item 4).
7. **Ativação (E3)**: CLI do vertical, idempotente, em transação com lock por workspace. Reexecutar não reconcede nem recria papel. Desativar revoga as chaves do vertical de todos os papéis e incrementa `tokenVersion`, mas **não apaga dados nem levanta a restrição**. Papel do vertical: `isSystem: true`, `systemKey` com prefixo; não prometa edição, porque o Core não edita papéis. Nome de papel em colisão aborta a ativação sem efeito nenhum. Separe o corpo da CLI do ponto de entrada (`cli/<vertical>-command.ts`) para o teste de integração rodar o mesmo código. A trava consultiva por workspace é **tentada** (`pg_try_advisory_xact_lock`, com recusa clara), não esperada: a espera contaria no prazo da transação. Se precisar da versão que espera, ela devolve `void`, então use `$executeRawUnsafe`. Referência: Clinics, no adendo 3 do ADR-047.
8. **Restrição de conteúdo (E6)** quando o vertical tem dado S:
   - é derivada da **presença** do vertical (linha de ativação em qualquer status **ou** qualquer dado do vertical), nunca do status;
   - é restrita por padrão e controlada **por consumidor** (`ai`, `webhook`), e uma liberação nunca vale para outro consumidor;
   - falha fechada e não usa cache.
9. **Testes obrigatórios**:
   - P0 de isolamento em cada tabela, e FK composta recusando referência de outro workspace;
   - Core sem o vertical: lint e teste de fronteira;
   - ciclo `enable` → `disable` → `enable` convergente;
   - restrição: bateria do ADR-048 §6.6, inclusive com o vertical `disabled` e com a porta falhando;
   - testes estáticos: só o serviço de ativação escreve `RolePermission` no vertical, nada apaga a linha de ativação, e a lista de modelos da presença bate com o schema;
   - a CLI real: registrar as chaves no catálogo e provisionar um workspace novo dá zero chaves do vertical ao Owner;
   - nenhum conteúdo S em entidade do Core nem na auditoria.
10. **Revisão**: mudança em E1, E2, E3 ou E6 toca tenancy, RBAC ou IA, então exige `reviewer` + `security` antes do commit.
11. **Dados reais**: nenhum, enquanto os bloqueios do ADR do vertical estiverem abertos (no Clinics, B1–B4 do ADR-048 §10).
