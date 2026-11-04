import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { PermissionKey } from '@veyra/contracts';
import { PermissionsService } from '../auth/permissions.service';
import type { AuthContext } from '../common/decorators';
import { PrismaService, type Db } from '../prisma/prisma.service';

/**
 * CONTEÚDO PROTEGIDO POR CONTATO (E8; ADR-061, adendos 2 e 3): o ponto de
 * extensão da F5.3b, ao lado do E6 e independente dele. A extensão declara
 * QUAIS contatos têm o conteúdo escrito por pessoas protegido (notas e
 * tarefas), QUAL chave do catálogo dela libera a leitura, QUAL chave já revela
 * quem são esses contatos, e se o workspace do pedido está sujeito à proteção.
 * O Core aplica o filtro nas próprias consultas e confere as chaves, sem saber
 * POR QUE o contato é protegido.
 *
 * Os três modos, por pedido:
 * - `livre`: com a chave da leitura, ou fora de workspace sujeito — nada oculto;
 * - `restrito`: sem a chave da leitura, mas sabendo quem é protegido — o
 *   conteúdo dos protegidos sai como "Conteúdo restrito" (403 na lista dele);
 * - `uniforme`: sem as duas chaves, em workspace sujeito — TODO conteúdo ligado
 *   a uma pessoa (pelo contato, ou pela oportunidade com contato) é ocultado e
 *   as escritas que o tocariam são recusadas, igual para todo contato: nem o
 *   corpo, nem o aviso, nem o código de resposta revelam a classificação.
 *
 * Não é a restrição da E6 (a dos consumidores IA e webhook): liberar um contato
 * para IA não libera esta leitura, e não estar liberado não protege nada aqui.
 * Sem extensão composta, nada é protegido — o Core puro.
 */
export interface ProtectedContentProvider {
  /** a chave do catálogo DA extensão que libera a leitura (soma-se à do recurso) */
  readonly unlockKey: string;
  /** a chave do catálogo DA extensão que já revela QUAIS contatos são protegidos */
  readonly revealKey: string;
  /**
   * Um filtro do Prisma sobre `Contact`, opaco para o Core: os contatos cujo
   * conteúdo é protegido. Derivado a cada consulta, sem cache: um contato que
   * passa a ser protegido deixa de ser servido no pedido seguinte.
   */
  contactFilter(): Record<string, unknown>;
  /**
   * O workspace do pedido (o do CLS) está sujeito à proteção? Um erro rejeita:
   * nunca vira "não sujeito".
   */
  appliesToWorkspace(): Promise<boolean>;
}

export const PROTECTED_CONTENT_PROVIDERS = Symbol('PROTECTED_CONTENT_PROVIDERS');

export const CONTEUDO_RESTRITO = 'Conteúdo restrito';

/** Os tipos de atividade da timeline que carregam conteúdo de nota ou tarefa. */
export const ATIVIDADES_DE_CONTEUDO = [
  'note_added',
  'note_deleted',
  'task_created',
  'task_completed',
] as const;

type Alvo = { contactId?: string | null; dealId?: string | null };
type Modo =
  { tipo: 'livre' } | { tipo: 'restrito'; oculto: Record<string, unknown> } | { tipo: 'uniforme' };

const COM_PESSOA = { contactId: { not: null } };

@Injectable()
export class ProtectedContentService {
  /** o modo de cada pedido (o `auth` é um objeto por pedido): uma conta só */
  private readonly modos = new WeakMap<AuthContext, Promise<Modo>>();

  constructor(
    @Inject(PROTECTED_CONTENT_PROVIDERS)
    private readonly providers: readonly ProtectedContentProvider[],
    private readonly permissions: PermissionsService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * O workspace está sujeito à proteção de alguma extensão? Para quem roda
   * FORA de um pedido (o worker de automações), sem `auth`: a consulta é
   * feita no CLS do workspace dado. Um erro rejeita, nunca vira "não sujeito".
   */
  async workspaceSujeito(workspaceId: string): Promise<boolean> {
    return this.cls.run(async () => {
      this.cls.set('workspaceId', workspaceId);
      for (const p of this.providers) {
        if (await p.appliesToWorkspace()) return true;
      }
      return false;
    });
  }

  private modo(auth: AuthContext): Promise<Modo> {
    let modo = this.modos.get(auth);
    if (!modo) {
      modo = this.calcularModo(auth);
      // um erro não fica guardado: o próximo uso tenta de novo (e rejeita de novo)
      modo.catch(() => this.modos.delete(auth));
      this.modos.set(auth, modo);
    }
    return modo;
  }

  private async calcularModo(auth: AuthContext): Promise<Modo> {
    const filtros: Record<string, unknown>[] = [];
    for (const p of this.providers) {
      const revela = await this.permissions.has(auth, p.revealKey as PermissionKey);
      const libera = await this.permissions.has(auth, p.unlockKey as PermissionKey);
      // ler o conteúdo protegido exige AS DUAS chaves (e a do recurso, na rota):
      // a chave da leitura sozinha, sem saber quem é protegido, não libera nada
      if (revela && libera) continue;
      if (!(await p.appliesToWorkspace())) continue;
      if (!revela) return { tipo: 'uniforme' };
      filtros.push(p.contactFilter());
    }
    if (filtros.length === 0) return { tipo: 'livre' };
    return { tipo: 'restrito', oculto: filtros.length === 1 ? filtros[0] : { OR: filtros } };
  }

  /**
   * Os contatos, dentre `ids`, cujo conteúdo é oculto para quem pede (ADR-061,
   * adendo 5): no `restrito`, os protegidos; no `uniforme`, todos (toda pessoa);
   * no `livre`, nenhum. Para o Core aplicar a regra a um lote (mídia, campos,
   * títulos) sem saber POR QUE o contato é protegido.
   */
  async contatosOcultos(
    auth: AuthContext,
    ids: readonly (string | null | undefined)[],
    db: Db = this.prisma.db,
  ): Promise<Set<string>> {
    const unicos = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unicos.length === 0) return new Set();
    const modo = await this.modo(auth);
    if (modo.tipo === 'livre') return new Set();
    if (modo.tipo === 'uniforme') return new Set(unicos);
    const rows = (await db.contact.findMany({
      where: { AND: [{ id: { in: unicos } }, modo.oculto] },
      select: { id: true },
    } as never)) as unknown as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /** As oportunidades, dentre `ids`, de contato oculto para quem pede (adendo 5). */
  async oportunidadesOcultas(
    auth: AuthContext,
    ids: readonly string[],
    db: Db = this.prisma.db,
  ): Promise<Set<string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0 || !(await this.duvidaOculta(auth))) return new Set();
    const rows = (await db.deal.findMany({
      where: { id: { in: unicos } },
      select: { id: true, contactId: true },
    } as never)) as unknown as { id: string; contactId: string | null }[];
    const ocultos = await this.contatosOcultos(
      auth,
      rows.map((r) => r.contactId),
      db,
    );
    return new Set(rows.filter((r) => r.contactId && ocultos.has(r.contactId)).map((r) => r.id));
  }

  /**
   * O contato é protegido por alguma extensão sujeita neste workspace,
   * INDEPENDENTE de quem pede (das chaves dele)? Para as regras que valem para
   * todos os papéis — a mídia histórica de uma conversa protegida (ADR-061,
   * adendo 6). Fora de workspace sujeito, nunca.
   */
  async contatoProtegido(contactId: string, db: Db = this.prisma.db): Promise<boolean> {
    for (const p of this.providers) {
      // primeiro pelo `db` de quem chama (a transação): só o contato que casa
      // com o filtro pede a consulta de presença — sem abrir conexões em
      // paralelo enquanto a transação segura as travas, no caso comum
      const n = await db.contact.count({
        where: { AND: [{ id: contactId }, p.contactFilter()] },
      } as never);
      if (n > 0 && (await p.appliesToWorkspace())) return true;
    }
    return false;
  }

  /**
   * Quem pede NÃO pode saber quem é protegido (o `uniforme`): uma decisão que
   * dependeria da classificação é recusada para toda pessoa (adendos 3 e 5).
   */
  async semClassificacao(auth: AuthContext): Promise<boolean> {
    return (await this.modo(auth)).tipo === 'uniforme';
  }

  /**
   * Na dúvida sobre de quem é o conteúdo (remetente a identificar, arquivo sem
   * vínculo), a regra é conservadora: oculto fora do `livre` (adendo 5).
   */
  async duvidaOculta(auth: AuthContext): Promise<boolean> {
    return (await this.modo(auth)).tipo !== 'livre';
  }

  /**
   * O `where` que EXCLUI de uma lista de notas ou tarefas o que é oculto para
   * quem pede: pelo contato ou pela oportunidade dele. `{}`: nada a excluir.
   */
  async visivel(auth: AuthContext): Promise<Record<string, unknown>> {
    const modo = await this.modo(auth);
    if (modo.tipo === 'livre') return {};
    if (modo.tipo === 'uniforme') {
      // só o que não tem pessoa: sem contato, e sem oportunidade com contato
      return { contactId: null, OR: [{ dealId: null }, { deal: { is: { contactId: null } } }] };
    }
    const o = modo.oculto;
    return { NOT: { OR: [{ contact: o }, { deal: { contact: o } }] } };
  }

  /** O mesmo para as atividades da timeline de nota e tarefa (também pela tarefa). */
  async atividadeVisivel(auth: AuthContext): Promise<Record<string, unknown>> {
    const modo = await this.modo(auth);
    if (modo.tipo === 'livre') return {};
    const ligacoes =
      modo.tipo === 'uniforme'
        ? [
            COM_PESSOA,
            { deal: { is: COM_PESSOA } },
            { task: { is: COM_PESSOA } },
            { task: { is: { deal: { is: COM_PESSOA } } } },
          ]
        : [
            { contact: modo.oculto },
            { deal: { contact: modo.oculto } },
            { task: { contact: modo.oculto } },
            { task: { deal: { contact: modo.oculto } } },
          ];
    return { NOT: { type: { in: [...ATIVIDADES_DE_CONTEUDO] }, OR: ligacoes } };
  }

  /**
   * O alvo (contato ou oportunidade) é oculto para quem pede? No `restrito`,
   * quando é protegido; no `uniforme`, quando é uma pessoa — qualquer uma.
   */
  async alvoOculto(auth: AuthContext, alvo: Alvo, db: Db = this.prisma.db): Promise<boolean> {
    const modo = await this.modo(auth);
    if (modo.tipo === 'livre') return false;
    if (modo.tipo === 'uniforme') {
      if (alvo.contactId) return true;
      if (alvo.dealId) {
        return (await db.deal.count({ where: { id: alvo.dealId, ...COM_PESSOA } } as never)) > 0;
      }
      return false;
    }
    if (alvo.contactId) {
      const n = await db.contact.count({
        where: { AND: [{ id: alvo.contactId }, modo.oculto] },
      } as never);
      if (n > 0) return true;
    }
    if (alvo.dealId) {
      const n = await db.deal.count({
        where: { id: alvo.dealId, contact: modo.oculto },
      } as never);
      if (n > 0) return true;
    }
    return false;
  }

  /**
   * Escrever no alvo (criar nota ou tarefa, levar uma tarefa até ele, mover ou
   * apagar a oportunidade): oculto, 403 "Conteúdo restrito". Quem não lê não
   * escreve ali; no `uniforme`, a recusa é a mesma para toda pessoa.
   */
  async exigirAlvoVisivel(auth: AuthContext, alvo: Alvo, db: Db = this.prisma.db): Promise<void> {
    if (await this.alvoOculto(auth, alvo, db)) throw new ForbiddenException(CONTEUDO_RESTRITO);
  }

  /**
   * A lista pedida PARA um alvo. `restrito` e protegido: 403 "Conteúdo
   * restrito" (quem pede já sabe quem é). `uniforme` e pessoa: a lista vazia
   * (`false`), igual para todo contato. `true`: listar normalmente.
   */
  async listaDoAlvo(auth: AuthContext, alvo: Alvo): Promise<boolean> {
    if (!(await this.alvoOculto(auth, alvo))) return true;
    if ((await this.modo(auth)).tipo === 'uniforme') return false;
    throw new ForbiddenException(CONTEUDO_RESTRITO);
  }

  /**
   * Excluir uma empresa, um contato ou uma oportunidade apaga em cascata as
   * notas (e, da oportunidade, as tarefas) ligadas a ela — inclusive as que
   * têm OUTRO alvo oculto para quem pede (uma nota da empresa e de uma pessoa protegida).
   * Se a cascata levaria algo que quem pede não apagaria diretamente, a
   * exclusão é recusada com o mesmo 403, e nada é apagado (ADR-061, adendo 4).
   * No `uniforme`, oculto é tudo o que tem pessoa: a recusa não distingue
   * a pessoa protegida das outras.
   */
  async exigirCascataVisivel(
    auth: AuthContext,
    cascata: { notas?: Record<string, unknown>; tarefas?: Record<string, unknown> },
    db: Db = this.prisma.db,
  ): Promise<void> {
    const visivel = await this.visivel(auth);
    if (Object.keys(visivel).length === 0) return;
    const oculto = { NOT: visivel };
    if (cascata.notas) {
      const n = await db.note.count({ where: { AND: [cascata.notas, oculto] } } as never);
      if (n > 0) throw new ForbiddenException(CONTEUDO_RESTRITO);
    }
    if (cascata.tarefas) {
      const n = await db.task.count({ where: { AND: [cascata.tarefas, oculto] } } as never);
      if (n > 0) throw new ForbiddenException(CONTEUDO_RESTRITO);
    }
  }

  /**
   * Excluir um contato apaga as notas dele, e a recusa do contato protegido (409)
   * denunciaria a classificação: no `uniforme`, 403 para todo contato.
   */
  async exigirPessoasVisiveis(auth: AuthContext): Promise<void> {
    if ((await this.modo(auth)).tipo === 'uniforme') {
      throw new ForbiddenException(CONTEUDO_RESTRITO);
    }
  }
}
