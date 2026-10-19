import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CLINICS_PERMISSION_CATALOG,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../audit/audit.service';
import type { Prisma } from '../../generated/prisma/client';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CLINICS_PROFESSIONAL_CORE_KEYS,
  CLINICS_PROFESSIONAL_ROLE_NAME,
  CLINICS_ROLE_GRANTS,
} from './clinics-permissions';

type Tx = Prisma.TransactionClient;

export type ActivationOutcome = 'enabled' | 'reenabled' | 'already_active';
export type DeactivationOutcome = 'disabled' | 'already_inactive';

export interface ActivationReport {
  outcome: ActivationOutcome;
  workspaceId: string;
  /** webhooks ativos, que deixam de receber eventos de contato (ADR-048 §6.5) */
  activeWebhooks: number;
  /** conteúdo de IA anterior expirado; `null` = a limpeza falhou (a leitura já o oculta) */
  expiredContent: { results: number; proposals: number; replays: number } | null;
}

const ACTOR = { type: 'system' as const, id: 'clinics-cli' };
/** Prazo explícito: o padrão de 5 s do Prisma é curto para o catálogo + matriz sob carga. */
const TX_OPTIONS = { timeout: 15_000 } as const;

/**
 * Ciclo de vida da ativação do Clinics (ADR-047 §4), usado pela CLI.
 *
 * `raw` justificado, como no provisionamento: é rotina ADMINISTRATIVA fora de
 * qualquer sessão (sem CLS), sobre um workspace achado pelo slug, com
 * `workspaceId` explícito em toda escrita. Tudo numa transação, sob trava
 * consultiva por workspace: reexecutar é seguro e o efeito depende do estado,
 * não do número de execuções.
 *
 * É o ÚNICO escritor de `RolePermission` do vertical (teste de fronteira), e só
 * concede onde o vertical está sendo ativado.
 */
@Injectable()
export class ClinicsActivationService {
  private readonly logger = new Logger(ClinicsActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly intelligence: IntelligenceService,
  ) {}

  async enable(slug: string): Promise<ActivationReport> {
    const workspaceId = await this.workspaceIdOf(slug);
    const outcome = await this.prisma.raw.$transaction(async (tx) => {
      await this.lock(tx, workspaceId);
      const settings = await tx.clinicsSettings.findFirst({ where: { workspaceId } });
      if (settings?.status === 'active') return 'already_active' as const;

      await this.registerCatalog(tx);
      const professionalRoleId = await this.ensureProfessionalRole(tx, workspaceId);
      const affectedRoles = await this.grantMatrix(tx, workspaceId, professionalRoleId);
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
    }, TX_OPTIONS);

    const activeWebhooks = await this.prisma.raw.webhook.count({
      where: { workspaceId, status: 'active' },
    });
    if (outcome === 'already_active') {
      return { outcome, workspaceId, activeWebhooks, expiredContent: null };
    }
    return { outcome, workspaceId, activeWebhooks, expiredContent: await this.expire(workspaceId) };
  }

  async disable(slug: string): Promise<{ outcome: DeactivationOutcome; workspaceId: string }> {
    const workspaceId = await this.workspaceIdOf(slug);
    const outcome = await this.prisma.raw.$transaction(async (tx) => {
      await this.lock(tx, workspaceId);
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
    }, TX_OPTIONS);
    return { outcome, workspaceId };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

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
        'Outra ativação ou desativação do Clinics neste workspace está em andamento. Tente de novo em instantes.',
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
   * Papel de sistema `Profissional`, localizado SEMPRE pelo `systemKey` — nunca
   * pelo nome. Se o nome já pertence a outro papel, a ativação ABORTA (sem
   * renomear em silêncio): o rollback desfaz tudo.
   */
  private async ensureProfessionalRole(tx: Tx, workspaceId: string): Promise<string> {
    const existing = await tx.role.findFirst({
      where: { workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
    });
    if (existing) return existing.id;
    const homonimo = await tx.role.findFirst({
      where: { workspaceId, name: CLINICS_PROFESSIONAL_ROLE_NAME },
    });
    if (homonimo) {
      throw new Error(
        `Já existe um papel chamado "${CLINICS_PROFESSIONAL_ROLE_NAME}" neste workspace, ` +
          'que não é o papel do Clinics. Renomeie-o antes de ativar o vertical.',
      );
    }
    const role = await tx.role.create({
      data: {
        workspaceId,
        name: CLINICS_PROFESSIONAL_ROLE_NAME,
        description: 'Consulta a agenda e registra atendimentos da clínica',
        isSystem: true,
        systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY,
      },
    });
    await tx.rolePermission.createMany({
      data: CLINICS_PROFESSIONAL_CORE_KEYS.map((permissionKey) => ({
        workspaceId,
        roleId: role.id,
        permissionKey,
      })),
      skipDuplicates: true,
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
        `Limpeza de conteúdo de IA falhou após a ativação: ${
          error instanceof Error ? error.name : 'erro desconhecido'
        }`,
      );
      return null;
    }
  }
}
