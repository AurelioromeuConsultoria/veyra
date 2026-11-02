import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { nomeDePapelComoSeLe } from '@veyra/contracts';
import {
  CLINICS_PERMISSION_CATALOG,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../audit/audit.service';
import { postgresErrorCode } from '../../common/prisma-exception.filter';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import type { Prisma } from '../../generated/prisma/client';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import { lockWorkspaceMembers } from '../../workspaces/members-lock';
import {
  CLINICS_ROLE_GRANTS,
  CLINICS_VERTICAL_ROLES,
  chavesPadraoDoPapel,
  type PapelDoVertical,
} from './clinics-permissions';

type Tx = Prisma.TransactionClient;

export type ActivationOutcome = 'enabled' | 'reenabled' | 'already_active';
export type DeactivationOutcome = 'disabled' | 'already_inactive';

export interface DeactivationReport {
  outcome: DeactivationOutcome;
  workspaceId: string;
  /** conteúdo de IA expirado depois do commit; `null` = a limpeza falhou ou nada mudou */
  expiredContent: { results: number; proposals: number; replays: number } | null;
}

/** Uma diferença entre um papel do vertical e a matriz padrão: informada, NUNCA corrigida. */
export type DivergenciaDePapel =
  /** o papel do vertical não existe, e o nome dele é de OUTRO papel (`deChave`: o dele, ou null no personalizado) */
  | { systemKey: string; tipo: 'nome_em_uso'; nome: string; deChave: string | null }
  /** o papel existe com outro nome (personalizado) */
  | { systemKey: string; tipo: 'nome_diferente'; nome: string; esperado: string }
  | { systemKey: string; tipo: 'chaves_a_menos' | 'chaves_a_mais'; nome: string; chaves: string[] };

export interface RolesSyncReport {
  outcome: 'synced' | 'clinics_inactive';
  workspaceId: string;
  /** os papéis criados, pelo nome */
  criados: { systemKey: string; nome: string }[];
  divergencias: DivergenciaDePapel[];
}

export interface ActivationReport {
  outcome: ActivationOutcome;
  workspaceId: string;
  /** webhooks ativos, que deixam de receber eventos de contato (ADR-048 §6.5) */
  activeWebhooks: number;
  /** conteúdo de IA anterior expirado; `null` = a limpeza falhou (a leitura já o oculta) */
  expiredContent: { results: number; proposals: number; replays: number } | null;
  /** os papéis do vertical criados AGORA (na reativação, o que faltava; ADR-056) */
  papeisCriados: { systemKey: string; nome: string }[];
}

const ACTOR = { type: 'system' as const, id: 'clinics-cli' };

/**
 * Um papel PERSONALIZADO (ou de outra chave) com o nome do papel do vertical,
 * como a pessoa o lê: "RECEPÇÃO E ATENDIMENTO", ou com o "ç" decomposto, é o
 * mesmo nome, e a unique do banco (exata) não o pega.
 */
async function homonimoDe(tx: Tx, workspaceId: string, papel: PapelDoVertical) {
  // filtrado AQUI, e não no banco: `NOT (systemKey = x)` deixa de fora o
  // personalizado, cujo `systemKey` é NULL — justamente o homônimo procurado
  const papeis = await tx.role.findMany({
    where: { workspaceId },
    select: { id: true, name: true, systemKey: true },
  });
  return (
    papeis.find(
      (r) =>
        r.systemKey !== papel.systemKey &&
        nomeDePapelComoSeLe(r.name) === nomeDePapelComoSeLe(papel.name),
    ) ?? null
  );
}

/**
 * Ciclo de vida da ativação do Clinics (ADR-047 §4), usado pela CLI.
 *
 * `raw` justificado, como no provisionamento: é rotina ADMINISTRATIVA fora de
 * qualquer sessão (sem CLS), sobre um workspace achado pelo slug, com
 * `workspaceId` explícito em toda escrita. Tudo numa transação, sob trava
 * consultiva por workspace: reexecutar é seguro e o efeito depende do estado,
 * não do número de execuções.
 *
 * Ativar e desativar são MUDANÇAS DO WORKSPACE INTEIRO (ADR-047 adendo 6 §6):
 * depois da trava tentada entre CLIs, a trava de restrição do workspace,
 * EXCLUSIVA, espera os usos e as aprovações em andamento (até 90 s) e marca os
 * usos órfãos do workspace. Estourar a espera não muda nada e responde com uma
 * mensagem clara. Os dois expiram o conteúdo de IA depois do commit.
 *
 * Os dois pegam também a trava dos membros, depois da do workspace e da marcação
 * dos órfãos, e antes das linhas de papel, permissão, membership e configuração
 * (ADR-056 adendo 1): eles tiram e devolvem as chaves dos papéis
 * do vertical, e nenhuma atribuição de papel corre no meio. A que chega durante
 * a desativação espera e lê o papel já sem as chaves, que o Core não atribui.
 *
 * É o ÚNICO escritor de `RolePermission` do vertical (teste de fronteira). Só
 * concede na ativação e, na sincronização dos papéis, onde o vertical JÁ está
 * ativo (ADR-056).
 */
@Injectable()
export class ClinicsActivationService {
  private readonly logger = new Logger(ClinicsActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly intelligence: IntelligenceService,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  async enable(slug: string): Promise<ActivationReport> {
    const workspaceId = await this.workspaceIdOf(slug);
    const papeisCriados: ActivationReport['papeisCriados'] = [];
    const outcome = await this.naMudanca(async (tx) => {
      await this.lock(tx, workspaceId);
      await this.restricao.doWorkspaceInteiro(tx as unknown as Db, workspaceId);
      await lockWorkspaceMembers(tx, workspaceId);
      const settings = await tx.clinicsSettings.findFirst({ where: { workspaceId } });
      if (settings?.status === 'active') return 'already_active' as const;

      await this.registerCatalog(tx);
      const papeis = new Map<string, string>();
      for (const papel of CLINICS_VERTICAL_ROLES) {
        const { id, criado } = await this.ensureRole(tx, workspaceId, papel);
        papeis.set(papel.systemKey, id);
        if (criado) papeisCriados.push({ systemKey: papel.systemKey, nome: papel.name });
      }
      const affectedRoles = await this.grantMatrix(
        tx,
        workspaceId,
        papeis.get(CLINICS_PROFESSIONAL_SYSTEM_KEY) as string,
      );
      await this.bumpSessions(tx, workspaceId, affectedRoles);

      let settingsId: string;
      if (settings) {
        await tx.clinicsSettings.updateMany({
          where: { workspaceId, id: settings.id },
          // `activatedAt` = ativação VIGENTE; o histórico completo está na auditoria
          data: { status: 'active', activatedAt: new Date(), disabledAt: null },
        });
        settingsId = settings.id;
      } else {
        settingsId = (
          await tx.clinicsSettings.create({
            // explícito, no MESMO relógio de `disabledAt` e da reativação
            data: { workspaceId, status: 'active', activatedAt: new Date() },
          })
        ).id;
        await tx.clinicsUnit.create({ data: { workspaceId, name: 'Unidade principal' } });
      }
      const action = settings ? 'clinics.reenabled' : 'clinics.enabled';
      await this.audit.record(tx, workspaceId, action, {
        entityType: 'clinicsSettings',
        entityId: settingsId,
        actor: ACTOR,
        before: settings ? { status: settings.status } : null,
        after: { status: 'active' },
      });
      return settings ? ('reenabled' as const) : ('enabled' as const);
    });

    const activeWebhooks = await this.prisma.raw.webhook.count({
      where: { workspaceId, status: 'active' },
    });
    if (outcome === 'already_active') {
      return { outcome, workspaceId, activeWebhooks, expiredContent: null, papeisCriados: [] };
    }
    return {
      outcome,
      workspaceId,
      activeWebhooks,
      expiredContent: await this.expire(workspaceId),
      papeisCriados,
    };
  }

  async disable(slug: string): Promise<DeactivationReport> {
    const workspaceId = await this.workspaceIdOf(slug);
    const outcome = await this.naMudanca(async (tx) => {
      await this.lock(tx, workspaceId);
      await this.restricao.doWorkspaceInteiro(tx as unknown as Db, workspaceId);
      await lockWorkspaceMembers(tx, workspaceId);
      const settings = await tx.clinicsSettings.findFirst({ where: { workspaceId } });
      if (!settings || settings.status !== 'active') return 'already_inactive' as const;

      // TODAS as chaves do vertical saem de TODOS os papéis (sistema e
      // customizados) — e os tokens de acesso de quem as tinha deixam de valer
      const affected = await tx.rolePermission.findMany({
        where: { workspaceId, permissionKey: { startsWith: 'clinics:' } },
        select: { roleId: true },
        distinct: ['roleId'],
      });
      await tx.rolePermission.deleteMany({
        where: { workspaceId, permissionKey: { startsWith: 'clinics:' } },
      });
      await this.bumpSessions(
        tx,
        workspaceId,
        affected.map((row) => row.roleId),
      );
      // NADA de dado é apagado; a linha de ativação fica (a restrição de
      // conteúdo depende da PRESENÇA do vertical, não do status)
      await tx.clinicsSettings.updateMany({
        where: { workspaceId, id: settings.id },
        data: { status: 'disabled', disabledAt: new Date() },
      });
      await this.audit.record(tx, workspaceId, 'clinics.disabled', {
        entityType: 'clinicsSettings',
        entityId: settings.id,
        actor: ACTOR,
        before: { status: 'active' },
        after: { status: 'disabled' },
      });
      return 'disabled' as const;
    });
    if (outcome === 'already_inactive') return { outcome, workspaceId, expiredContent: null };
    // como na ativação (ADR-047 adendo 6 §6): o conteúdo de IA do workspace
    // expira depois do commit
    return { outcome, workspaceId, expiredContent: await this.expire(workspaceId) };
  }

  /**
   * A SINCRONIZAÇÃO dos papéis do vertical num workspace com o Clinics JÁ ativo
   * (ADR-056, item 5), explícita por workspace, pela CLI. A ativação só cria
   * papéis na primeira vez; esta cria o papel AUSENTE, com a matriz padrão, e
   * nada além disso:
   * - não altera memberships nem atribui o papel novo;
   * - não sobrescreve permissões nem nomes de um papel que já existe, e por
   *   isso, repetida, não desfaz uma alteração feita depois;
   * - informa as divergências com a matriz padrão, sem corrigi-las.
   * Auditada: cada papel criado (`role.created`) e a própria execução.
   */
  async syncRoles(slug: string): Promise<RolesSyncReport> {
    const workspaceId = await this.workspaceIdOf(slug);
    return this.naMudanca(async (tx) => {
      await this.lock(tx, workspaceId);
      const settings = await tx.clinicsSettings.findFirst({ where: { workspaceId } });
      if (settings?.status !== 'active') {
        return { outcome: 'clinics_inactive', workspaceId, criados: [], divergencias: [] };
      }
      // a FK de `RolePermission` exige as chaves do vertical no catálogo global
      await this.registerCatalog(tx);
      const criados: RolesSyncReport['criados'] = [];
      const divergencias: DivergenciaDePapel[] = [];
      for (const papel of CLINICS_VERTICAL_ROLES) {
        const padrao = chavesPadraoDoPapel(papel);
        const existente = await tx.role.findFirst({
          where: { workspaceId, systemKey: papel.systemKey },
          include: { permissions: { select: { permissionKey: true } } },
        });
        if (!existente) {
          const homonimo = await homonimoDe(tx, workspaceId, papel);
          if (homonimo) {
            divergencias.push({
              systemKey: papel.systemKey,
              tipo: 'nome_em_uso',
              nome: homonimo.name,
              deChave: homonimo.systemKey,
            });
            continue;
          }
          await this.createRole(tx, workspaceId, papel, padrao);
          criados.push({ systemKey: papel.systemKey, nome: papel.name });
          continue;
        }
        if (existente.name !== papel.name) {
          divergencias.push({
            systemKey: papel.systemKey,
            tipo: 'nome_diferente',
            nome: existente.name,
            esperado: papel.name,
          });
        }
        const atuais = new Set(existente.permissions.map((p) => p.permissionKey));
        const aMenos = padrao.filter((k) => !atuais.has(k));
        const aMais = [...atuais].filter((k) => !padrao.includes(k)).sort();
        if (aMenos.length > 0) {
          divergencias.push({
            systemKey: papel.systemKey,
            tipo: 'chaves_a_menos',
            nome: existente.name,
            chaves: aMenos,
          });
        }
        if (aMais.length > 0) {
          divergencias.push({
            systemKey: papel.systemKey,
            tipo: 'chaves_a_mais',
            nome: existente.name,
            chaves: aMais,
          });
        }
      }
      await this.audit.record(tx, workspaceId, 'clinics.roles_synced', {
        entityType: 'clinicsSettings',
        entityId: settings.id,
        actor: ACTOR,
        before: null,
        after: {
          rolesCreated: criados.map((c) => c.systemKey),
          rolesDivergent: [...new Set(divergencias.map((d) => d.systemKey))],
        },
      });
      return { outcome: 'synced', workspaceId, criados, divergencias };
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * A transação da mudança, com o prazo da espera pelos usos (120 s). Estourar
   * a espera pela trava do workspace (55P03) não muda nada e vira uma mensagem
   * clara para quem roda a CLI.
   */
  private async naMudanca<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.raw.$transaction(fn, this.restricao.transacaoDoWorkspace);
    } catch (error) {
      // 55P03: a espera pela trava; P2028: o prazo da transação inteira
      const codigo = postgresErrorCode(error) ?? (error as { code?: unknown } | null)?.code;
      if (codigo === '55P03' || codigo === 'P2028') {
        throw new ConflictException(
          'Há usos de conteúdo ou mudanças na equipe em andamento neste workspace que não terminaram a tempo. ' +
            'Nada mudou; tente de novo em instantes.',
        );
      }
      throw error;
    }
  }

  private async workspaceIdOf(slug: string): Promise<string> {
    // `raw` justificado: Workspace é a raiz global; lookup administrativo por slug
    const workspace = await this.prisma.raw.workspace.findUnique({ where: { slug } });
    if (!workspace) throw new NotFoundException(`Workspace não encontrado: ${slug}`);
    return workspace.id;
  }

  /**
   * Exclusão mútua entre ativação e desativação do MESMO workspace. TENTA a
   * trava em vez de esperar: esperar contaria no prazo da transação e a CLI
   * morreria com um erro interno em inglês. Duas execuções simultâneas são
   * acidente de operação, e a segunda recusa com uma mensagem clara, sem efeito.
   */
  private async lock(tx: Tx, workspaceId: string): Promise<void> {
    const [{ locked }] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked',
      'clinics_activation',
      workspaceId,
    );
    if (!locked) {
      throw new ConflictException(
        'Outra ativação, desativação ou sincronização do Clinics neste workspace está em andamento. Tente de novo em instantes.',
      );
    }
  }

  /** Catálogo GLOBAL de permissões: a FK de `RolePermission` exige as chaves. */
  private async registerCatalog(tx: Tx): Promise<void> {
    for (const [key, description] of Object.entries(CLINICS_PERMISSION_CATALOG)) {
      await tx.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      });
    }
  }

  /**
   * Um papel de sistema do vertical, localizado SEMPRE pelo `systemKey` — nunca
   * pelo nome. Se o nome já pertence a outro papel, a ativação ABORTA (sem
   * renomear em silêncio): o rollback desfaz tudo. Nasce com a matriz PADRÃO
   * inteira (a trilha registra qual); na reativação, a matriz devolve as do Clinics.
   */
  private async ensureRole(
    tx: Tx,
    workspaceId: string,
    papel: PapelDoVertical,
  ): Promise<{ id: string; criado: boolean }> {
    const existing = await tx.role.findFirst({
      where: { workspaceId, systemKey: papel.systemKey },
    });
    if (existing) return { id: existing.id, criado: false };
    const homonimo = await homonimoDe(tx, workspaceId, papel);
    if (homonimo) {
      throw new Error(
        `Já existe um papel chamado "${homonimo.name}" neste workspace, ` +
          'que não é o papel do Clinics. Renomeie-o antes de ativar o vertical.',
      );
    }
    return {
      id: await this.createRole(tx, workspaceId, papel, chavesPadraoDoPapel(papel)),
      criado: true,
    };
  }

  private async createRole(
    tx: Tx,
    workspaceId: string,
    papel: PapelDoVertical,
    keys: readonly string[],
  ): Promise<string> {
    const role = await tx.role.create({
      data: {
        workspaceId,
        name: papel.name,
        description: papel.description,
        isSystem: true,
        systemKey: papel.systemKey,
      },
    });
    await tx.rolePermission.createMany({
      data: keys.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
    // a criação fica na trilha, pela ativação ou pela sincronização, com as
    // chaves com que o papel nasceu
    await this.audit.record(tx, workspaceId, 'role.created', {
      entityType: 'role',
      entityId: role.id,
      actor: ACTOR,
      before: null,
      after: {
        name: papel.name,
        description: papel.description,
        permissionKeys: [...keys].sort(),
      },
    });
    return role.id;
  }

  /** Concede a matriz aprovada, por `systemKey`. Devolve os papéis tocados. */
  private async grantMatrix(
    tx: Tx,
    workspaceId: string,
    professionalRoleId: string,
  ): Promise<string[]> {
    const roles = await tx.role.findMany({
      where: { workspaceId, systemKey: { in: Object.keys(CLINICS_ROLE_GRANTS) } },
      select: { id: true, systemKey: true },
    });
    const affected: string[] = [];
    for (const role of roles) {
      const keys = CLINICS_ROLE_GRANTS[role.systemKey as string] ?? [];
      if (keys.length === 0) continue;
      await tx.rolePermission.createMany({
        data: keys.map((permissionKey) => ({ workspaceId, roleId: role.id, permissionKey })),
        skipDuplicates: true,
      });
      affected.push(role.id);
    }
    if (!affected.includes(professionalRoleId)) {
      throw new Error('Papel Profissional sem concessão — matriz inconsistente');
    }
    return affected;
  }

  /**
   * Mudança de permissão invalida os tokens de acesso emitidos antes (ADR-009):
   * 401 na request seguinte, e o refresh emite outro com as permissões atuais.
   */
  private async bumpSessions(tx: Tx, workspaceId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    await tx.membership.updateMany({
      where: { workspaceId, roleId: { in: roleIds } },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  /**
   * Expira o conteúdo de IA do workspace (ADR-048 §6.3, item 7). Complementar:
   * a leitura já o oculta, então falhar aqui não expõe nada — só é relatado.
   */
  private async expire(workspaceId: string): Promise<ActivationReport['expiredContent']> {
    try {
      return await this.cls.run(async () => {
        this.cls.set('workspaceId', workspaceId);
        return this.intelligence.expireContentFor('workspace');
      });
    } catch (error) {
      this.logger.error(
        `Limpeza de conteúdo de IA falhou após mudar a ativação: ${
          error instanceof Error ? error.name : 'erro desconhecido'
        }`,
      );
      return null;
    }
  }
}
