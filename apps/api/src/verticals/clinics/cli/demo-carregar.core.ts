import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createContactSchema, type PermissionKey } from '@veyra/contracts';
import {
  createClinicsAppointmentSchema,
  createClinicsProfessionalSchema,
  createClinicsReturnSchema,
  createClinicsServiceSchema,
  horaLocal,
} from '@veyra/contracts/verticals/clinics';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import { transporteSimulado } from '../../../common/transporte-simulado';
import type { AuthContext } from '../../../common/decorators';
import { ContactsService } from '../../../contacts/contacts.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ClinicsServiceCatalog } from '../catalog/clinics-service-catalog.service';
import { ClinicsProfessionalsService } from '../catalog/clinics-professionals.service';
import { ClinicsPatientsService } from '../clinics-patients.service';
import { ClinicsAppointmentsService } from '../schedule/clinics-appointments.service';
import { ClinicsReturnsService } from '../schedule/clinics-returns.service';
import {
  EXPEDIENTE_DA_CARGA,
  ORIGEM_DA_DEMONSTRACAO,
  PACIENTES_DA_CARGA,
  PROFISSIONAIS_DA_CARGA,
  SERVICOS_DA_CARGA,
} from './carga-da-demonstracao';

/**
 * A carga da demonstração (`demo:carregar`, ADR-048 adendo 13): dados
 * FICTÍCIOS num workspace explícito, com o Clinics já ativo, pelos serviços de
 * sempre — cada registro com as validações (os mesmos schemas das rotas) e a
 * trilha dele, em nome do ator.
 *
 * - Não ativa o Clinics, não cria consentimento, finalidade, canal nem
 *   template, e não revisa template.
 * - Só com o transporte simulado (o ambiente da demonstração).
 * - A REEXECUÇÃO: depois da carga completa, o marcador da trilha
 *   (`clinics.demo_loaded`) faz a carga não fazer nada. Depois de uma
 *   interrupção, ela completa só o que falta e nunca altera o que existe:
 *   o contato pelo número exato, o paciente pelo contato, o agendamento e o
 *   retorno só para o paciente que não tem nenhum, e o catálogo pelo nome —
 *   só enquanto não houver nele nada fora do plano (o que o usuário criou ou
 *   renomeou pela tela).
 */

export class RecusaDaCarga extends Error {}

export const MARCADOR_DA_CARGA = 'clinics.demo_loaded';

/** As permissões das rotas que a tela usaria para criar o mesmo. */
const PERMISSOES_DO_ATOR = [
  'contacts:write',
  'contacts:read',
  'clinics:catalog:manage',
  'clinics:schedule:write',
  'clinics:schedule:read',
  'clinics:care:write',
  'clinics:care:read',
] as const;

export interface EntradaDaCarga {
  slug: string;
  /** o e-mail do ator: em nome de quem os dados nascem */
  ator: string;
}

export interface ResultadoDaCarga {
  /** a carga já tinha terminado antes: nada foi feito */
  jaConcluida: Date | null;
  criados: {
    servicos: number;
    profissionais: number;
    contatos: number;
    pacientes: number;
    agendamentos: number;
    retornos: number;
  };
  /** o que ficou de fora, com o motivo (nunca um número de telefone) */
  pulados: string[];
}

/** A data local `dias` dias depois (ou antes, negativo) de `data` (AAAA-MM-DD). */
export function somarDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return d.toISOString().slice(0, 10);
}

/** O `n`-ésimo dia útil (segunda a sábado) depois de `hoje`. */
export function diaUtil(hoje: string, n: number): string {
  let data = hoje;
  let contados = 0;
  while (contados < n) {
    data = somarDias(data, 1);
    const [ano, mes, dia] = data.split('-').map(Number);
    if (new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay() !== 0) contados += 1;
  }
  return data;
}

/** A data local de hoje na unidade: o dia da carga é o do fuso dela, não o UTC. */
export function hojeNaUnidade(agora: Date, fuso: string): string {
  return horaLocal(agora, fuso).data;
}

/**
 * Uma criação pelo serviço: a recusa de regra (a `HttpException` do serviço:
 * fora do expediente, profissional arquivado, horário ocupado…) vira item
 * pulado, com o motivo, e a carga segue; a perda de acesso e qualquer outro
 * erro interrompem.
 */
async function tentar<T>(
  pulados: string[],
  rotulo: string,
  criar: () => Promise<T>,
): Promise<T | null> {
  try {
    return await criar();
  } catch (erro) {
    // a perda de acesso no meio (401/403) interrompe: não é recusa de regra, e
    // o marcador não pode ser gravado em nome de quem perdeu o acesso
    if (!(erro instanceof HttpException) || [401, 403].includes(erro.getStatus())) throw erro;
    pulados.push(`${rotulo}: ${erro.message}`);
    return null;
  }
}

export async function carregarDemonstracao(
  app: INestApplicationContext,
  entrada: EntradaDaCarga,
): Promise<ResultadoDaCarga> {
  if (!transporteSimulado(app.get(ConfigService))) {
    throw new RecusaDaCarga(
      'A carga só roda no ambiente da demonstração, com o transporte simulado (META_TRANSPORT_MODE=fake e VEYRA_ENV=staging).',
    );
  }
  const prisma = app.get(PrismaService);
  const cls = app.get(ClsService);
  // `raw` justificado: rotina administrativa (CLAUDE.md §3.3) que resolve o
  // workspace pelo slug e o usuário global pelo e-mail, antes de existir
  // contexto; o resto vai pelo client protegido, no contexto do workspace
  const workspace = await prisma.raw.workspace.findFirst({
    where: { slug: entrada.slug },
    select: { id: true, status: true },
  });
  if (!workspace || workspace.status !== 'active') {
    throw new RecusaDaCarga(`Workspace ${entrada.slug} não encontrado ou suspenso.`);
  }
  const usuario = await prisma.raw.user.findFirst({
    where: { email: entrada.ator.trim().toLowerCase(), status: 'active' },
    select: { id: true, email: true },
  });

  return cls.run(async () => {
    cls.set('workspaceId', workspace.id);
    const settings = await prisma.db.clinicsSettings.findFirst({ select: { status: true } });
    if (settings?.status !== 'active') {
      throw new RecusaDaCarga(
        `O Clinics não está ativo em ${entrada.slug}: a carga não o ativa (clinics:enable, com autorização).`,
      );
    }
    const membership = usuario
      ? await prisma.db.membership.findFirst({
          where: { userId: usuario.id, status: 'active' },
          select: { id: true, roleId: true },
        })
      : null;
    const permissoes = app.get(PermissionsService);
    const faltam: string[] = [];
    if (membership) {
      for (const chave of PERMISSOES_DO_ATOR) {
        if (!(await permissoes.membershipHas(membership.id, chave as PermissionKey))) {
          faltam.push(chave);
        }
      }
    }
    if (!usuario || !membership || faltam.length > 0) {
      throw new RecusaDaCarga(
        `O ator precisa ser usuário ativo e membro ativo de ${entrada.slug}, com ${PERMISSOES_DO_ATOR.join(', ')}` +
          (faltam.length > 0 ? ` (faltam: ${faltam.join(', ')}).` : '.'),
      );
    }
    // o contexto de uma requisição do ator: os serviços conferem o papel por ele.
    // O `requestId` marca na trilha cada registro da carga: o `:` fica fora do
    // formato que o cabeçalho HTTP aceita, e nenhuma requisição o forja
    cls.set('requestId', `cli:demo-carregar:${randomUUID()}`);
    cls.set('roleId', membership.roleId);
    cls.set('userId', usuario.id);
    cls.set('membershipId', membership.id);
    const auth: AuthContext = {
      userId: usuario.id,
      email: usuario.email,
      membershipId: membership.id,
      workspaceId: workspace.id,
      sessionId: 'cli:demo-carregar',
    };

    const resultado: ResultadoDaCarga = {
      jaConcluida: null,
      criados: {
        servicos: 0,
        profissionais: 0,
        contatos: 0,
        pacientes: 0,
        agendamentos: 0,
        retornos: 0,
      },
      pulados: [],
    };
    const marcador = await prisma.db.auditLog.findFirst({
      where: { action: MARCADOR_DA_CARGA },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (marcador) return { ...resultado, jaConcluida: marcador.createdAt };

    const unidade = await prisma.db.clinicsUnit.findFirst({
      where: { archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, timezone: true },
    });
    if (!unidade) throw new RecusaDaCarga(`${entrada.slug} não tem unidade ativa.`);

    // ── o catálogo: pelo nome, e só enquanto nada nele está fora do plano ──
    const servicos = await prisma.db.clinicsService.findMany({ select: { id: true, name: true } });
    const profissionais = await prisma.db.clinicsProfessional.findMany({
      select: { id: true, name: true },
    });
    const nomesDoPlano = new Set([
      ...SERVICOS_DA_CARGA.map((s) => s.nome),
      ...PROFISSIONAIS_DA_CARGA.map((p) => p.nome),
    ]);
    const foraDoPlano = [...servicos, ...profissionais].some((x) => !nomesDoPlano.has(x.name));
    const idDoServico = new Map(servicos.map((s) => [s.name, s.id]));
    const idDoProfissional = new Map(profissionais.map((p) => [p.name, p.id]));
    if (foraDoPlano) {
      resultado.pulados.push(
        'o catálogo: há serviço ou profissional fora do plano (criado ou renomeado pela tela)',
      );
    } else {
      for (const sv of SERVICOS_DA_CARGA) {
        if (idDoServico.has(sv.nome)) continue;
        const criado = await tentar(resultado.pulados, `o serviço ${sv.nome}`, () =>
          app.get(ClinicsServiceCatalog).create(
            auth,
            createClinicsServiceSchema.parse({
              name: sv.nome,
              durationMin: sv.duracaoMin,
              priceCents: sv.precoCentavos,
              returnIntervalDays: sv.retornoEmDias,
            }),
          ),
        );
        if (!criado) continue;
        idDoServico.set(sv.nome, criado.id);
        resultado.criados.servicos += 1;
      }
      for (const p of PROFISSIONAIS_DA_CARGA) {
        if (idDoProfissional.has(p.nome)) continue;
        const servicosDele = p.servicos.map((i) => idDoServico.get(SERVICOS_DA_CARGA[i].nome));
        if (servicosDele.some((id) => !id)) {
          resultado.pulados.push(`a profissional ${p.nome}: falta um serviço do plano`);
          continue;
        }
        const criado = await tentar(resultado.pulados, `a profissional ${p.nome}`, () =>
          app.get(ClinicsProfessionalsService).create(
            auth,
            createClinicsProfessionalSchema.parse({
              name: p.nome,
              serviceIds: servicosDele,
              intervals: EXPEDIENTE_DA_CARGA.dias.map((weekday) => ({
                unitId: unidade.id,
                weekday,
                startMinute: EXPEDIENTE_DA_CARGA.inicio,
                endMinute: EXPEDIENTE_DA_CARGA.fim,
              })),
            }),
          ),
        );
        if (!criado) continue;
        idDoProfissional.set(p.nome, criado.id);
        resultado.criados.profissionais += 1;
      }
    }

    // ── os pacientes: o contato pelo número exato, o paciente pelo contato ──
    // Com o catálogo mudado pela tela, o que dependeria dele também fica de
    // fora: os agendamentos e o retorno (adendo 13)
    if (foraDoPlano) {
      resultado.pulados.push('os agendamentos e o retorno: o catálogo foi mudado pela tela');
    }
    const hoje = hojeNaUnidade(new Date(), unidade.timezone);
    for (const p of PACIENTES_DA_CARGA) {
      const existente = await prisma.db.contact.findFirst({
        where: { phonesNormalized: { has: p.numero } },
        select: { id: true },
      });
      let contactId = existente?.id ?? null;
      if (!contactId) {
        const contato = await tentar(resultado.pulados, `o contato ${p.nome}`, () =>
          app.get(ContactsService).create(
            auth,
            createContactSchema.parse({
              name: p.nome,
              phones: [p.numero],
              source: ORIGEM_DA_DEMONSTRACAO,
            }),
          ),
        );
        if (!contato) continue;
        contactId = contato.id;
        resultado.criados.contatos += 1;
      }
      let paciente = await prisma.db.clinicsPatient.findFirst({
        where: { contactId },
        select: { id: true },
      });
      if (!paciente) {
        const doContato = contactId;
        const criado = await tentar(resultado.pulados, `a paciente ${p.nome}`, () =>
          app.get(ClinicsPatientsService).create(auth, doContato),
        );
        if (!criado) continue;
        paciente = { id: criado.id };
        resultado.criados.pacientes += 1;
      }
      const patientId = paciente.id;
      if (foraDoPlano) continue;

      if (
        p.agendamento &&
        (await prisma.db.clinicsAppointment.count({ where: { patientId } })) === 0
      ) {
        const ag = p.agendamento;
        const professionalId = idDoProfissional.get(PROFISSIONAIS_DA_CARGA[ag.profissional].nome);
        const serviceId = idDoServico.get(SERVICOS_DA_CARGA[ag.servico].nome);
        if (!professionalId || !serviceId) {
          resultado.pulados.push(`o agendamento de ${p.nome}: o catálogo do plano não existe`);
        } else {
          const criado = await tentar(resultado.pulados, `o agendamento de ${p.nome}`, () =>
            app.get(ClinicsAppointmentsService).create(
              auth,
              createClinicsAppointmentSchema.parse({
                patientId,
                professionalId,
                serviceId,
                unitId: unidade.id,
                date: diaUtil(hoje, ag.diaUtil),
                time: ag.hora,
              }),
            ),
          );
          if (criado) resultado.criados.agendamentos += 1;
        }
      }

      if (p.retorno && (await prisma.db.clinicsReturn.count({ where: { patientId } })) === 0) {
        const rt = p.retorno;
        const serviceId = idDoServico.get(SERVICOS_DA_CARGA[rt.servico].nome);
        if (!serviceId) {
          resultado.pulados.push(`o retorno de ${p.nome}: o catálogo do plano não existe`);
        } else {
          const criado = await tentar(resultado.pulados, `o retorno de ${p.nome}`, () =>
            app.get(ClinicsReturnsService).create(
              auth,
              createClinicsReturnSchema.parse({
                patientId,
                serviceId,
                unitId: unidade.id,
                dueDate: somarDias(hoje, -rt.diasAtras),
              }),
            ),
          );
          if (criado) resultado.criados.retornos += 1;
        }
      }
    }

    // a carga terminou, com o que foi pulado: o marcador faz a próxima não
    // fazer nada, e o que ficou de fora não é tentado de novo
    await app.get(AuditService).record(prisma.db, workspace.id, MARCADOR_DA_CARGA, {
      entityType: 'clinicsDemoLoad',
      entityId: workspace.id,
      actor: { type: 'user', membershipId: membership.id },
      after: { ...resultado.criados, pulados: resultado.pulados.length },
    });
    return resultado;
  });
}
