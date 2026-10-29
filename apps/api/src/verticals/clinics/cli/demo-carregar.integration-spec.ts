import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createContactSchema } from '@veyra/contracts';
import { createClinicsServiceSchema } from '@veyra/contracts/verticals/clinics';
import { ClsService } from 'nestjs-cls';
import type { AuthContext } from '../../../common/decorators';
import { ContactsService } from '../../../contacts/contacts.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { createTestApp } from '../../../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../../test/integration/fixtures';
import { resetDb } from '../../../../test/integration/harness';
import { ClinicsProfessionalsService } from '../catalog/clinics-professionals.service';
import { ClinicsServiceCatalog } from '../catalog/clinics-service-catalog.service';
import { ClinicsActivationService } from '../clinics-activation.service';
import { ClinicsPatientsService } from '../clinics-patients.service';
import { ClinicsAppointmentsService } from '../schedule/clinics-appointments.service';
import {
  EXPEDIENTE_DA_CARGA,
  PACIENTES_DA_CARGA,
  PROFISSIONAIS_DA_CARGA,
  SERVICOS_DA_CARGA,
} from './carga-da-demonstracao';
import { carregarDemonstracao, MARCADOR_DA_CARGA, RecusaDaCarga } from './demo-carregar.core';

/**
 * A carga da demonstração (`demo:carregar`, F4.4c, ADR-048 adendo 13): dados
 * FICTÍCIOS pelos serviços do domínio, num workspace explícito com o Clinics
 * ativo e o transporte simulado. O que se prova:
 *
 * - cada recusa vem antes de gravar qualquer coisa, e o outro workspace fica
 *   intocado (P0);
 * - a carga não cria consentimento, revisão nem ativação;
 * - depois da carga completa, rodar de novo não faz nada;
 * - depois de uma interrupção, completa só o que falta, sem duplicar e sem
 *   alterar o que o usuário mudou.
 */

const ATOR = 'dono@veyra.test';

describe('F4.4c — a carga da demonstração (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let donoA: string;

  /** O transporte simulado só durante a carga: o resto do app segue igual. */
  const simulado = <T>(fn: () => Promise<T>): Promise<T> => {
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    const espiao = jest
      .spyOn(config, 'get')
      .mockImplementation(((chave: string) =>
        chave === 'META_TRANSPORT_MODE'
          ? 'fake'
          : chave === 'VEYRA_ENV'
            ? 'staging'
            : original(chave)) as ConfigService['get']);
    return fn().finally(() => espiao.mockRestore());
  };
  const carregar = (ator = ATOR, slug = 'acme') =>
    simulado(() => carregarDemonstracao(app, { slug, ator }));

  /** No contexto do workspace A, como uma requisição do dono (a "tela"). */
  const comoDono = async <T>(fn: (auth: AuthContext) => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    const m = await prisma.raw.membership.findUniqueOrThrow({ where: { id: donoA } });
    return cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      cls.set('roleId', m.roleId);
      return await fn({
        userId: m.userId,
        email: ATOR,
        membershipId: donoA,
        workspaceId: wsA.workspaceId,
        sessionId: 'teste',
      });
    });
  };

  const contagem = async (workspaceId = wsA.workspaceId) => ({
    servicos: await prisma.raw.clinicsService.count({ where: { workspaceId } }),
    profissionais: await prisma.raw.clinicsProfessional.count({ where: { workspaceId } }),
    contatos: await prisma.raw.contact.count({ where: { workspaceId } }),
    pacientes: await prisma.raw.clinicsPatient.count({ where: { workspaceId } }),
    agendamentos: await prisma.raw.clinicsAppointment.count({ where: { workspaceId } }),
    retornos: await prisma.raw.clinicsReturn.count({ where: { workspaceId } }),
  });
  const COMPLETA = {
    servicos: 3,
    profissionais: 2,
    contatos: 6,
    pacientes: 6,
    agendamentos: 5,
    retornos: 1,
  };
  const VAZIA = {
    servicos: 0,
    profissionais: 0,
    contatos: 0,
    pacientes: 0,
    agendamentos: 0,
    retornos: 0,
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, ATOR);
    donoA = await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const membro = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, membro, wsA.roles.member);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    await app.get(ClinicsActivationService).enable('acme');
  });

  it('as recusas vêm antes de gravar qualquer coisa', async () => {
    // sem o transporte simulado
    await expect(carregarDemonstracao(app, { slug: 'acme', ator: ATOR })).rejects.toThrow(
      /só roda no ambiente da demonstração, com o transporte simulado/,
    );
    // o workspace sem o Clinics (a carga não o ativa)
    await expect(carregar('dono-b@veyra.test', 'beta')).rejects.toThrow(
      /O Clinics não está ativo em beta: a carga não o ativa/,
    );
    // o ator sem as permissões, o de outro workspace, o desconhecido e o suspenso
    await expect(carregar('membro@veyra.test')).rejects.toThrow(/faltam: .*clinics:catalog:manage/);
    for (const ator of ['dono-b@veyra.test', 'ninguem@veyra.test']) {
      await expect(carregar(ator)).rejects.toThrow(RecusaDaCarga);
    }
    await prisma.raw.user.updateMany({ where: { email: ATOR }, data: { status: 'suspended' } });
    await expect(carregar()).rejects.toThrow(/usuário ativo e membro ativo/);
    await prisma.raw.user.updateMany({ where: { email: ATOR }, data: { status: 'active' } });
    // o workspace suspenso e o inexistente
    await prisma.raw.workspace.updateMany({
      where: { id: wsA.workspaceId },
      data: { status: 'suspended' },
    });
    await expect(carregar()).rejects.toThrow(/não encontrado ou suspenso/);
    await expect(carregar(ATOR, 'nao-existe')).rejects.toThrow(/não encontrado ou suspenso/);
    expect(await contagem()).toEqual(VAZIA);
    expect(await contagem(wsB.workspaceId)).toEqual(VAZIA);
  });

  it('a carga completa: só dados fictícios, pelos serviços, sem consentimento, revisão nem ativação', async () => {
    const r = await carregar();
    expect(r).toEqual({ jaConcluida: null, criados: COMPLETA, pulados: [] });
    expect(await contagem()).toEqual(COMPLETA);
    const contatos = await prisma.raw.contact.findMany({ where: { workspaceId: wsA.workspaceId } });
    expect(contatos.map((c) => c.phonesNormalized[0]).sort()).toEqual(
      PACIENTES_DA_CARGA.map((p) => p.numero).sort(),
    );
    for (const c of contatos) expect(c.source).toBe('demonstração');
    // cada registro com a trilha do serviço, em nome do ator
    const trilha = await prisma.raw.auditLog.findMany({
      where: { workspaceId: wsA.workspaceId, entityType: 'clinicsAppointment' },
    });
    expect(trilha).toHaveLength(5);
    expect(new Set(trilha.map((t) => t.actorMembershipId))).toEqual(new Set([donoA]));
    // o marcador, com as contagens
    const [marcador] = await prisma.raw.auditLog.findMany({
      where: { workspaceId: wsA.workspaceId, action: MARCADOR_DA_CARGA },
    });
    expect(marcador.after).toEqual({ ...COMPLETA, pulados: 0 });
    // nada além dos dados
    expect(await prisma.raw.consent.count()).toBe(0);
    expect(await prisma.raw.templateReview.count()).toBe(0);
    expect(await prisma.raw.clinicsSettings.count()).toBe(1);
    expect(await contagem(wsB.workspaceId)).toEqual(VAZIA);
    // os agendamentos são futuros, e o retorno é pendente e vencido
    const agora = Date.now();
    for (const a of await prisma.raw.clinicsAppointment.findMany()) {
      expect(a.startsAt.getTime()).toBeGreaterThan(agora);
    }
    const [retorno] = await prisma.raw.clinicsReturn.findMany();
    expect(retorno.status).toBe('pending');
    expect(retorno.dueDate.getTime()).toBeLessThan(agora);
  });

  it('depois da carga completa, rodar de novo não faz nada, nem o que o usuário mudou volta', async () => {
    await carregar();
    const contato = await prisma.raw.contact.findFirstOrThrow({
      where: { phonesNormalized: { has: PACIENTES_DA_CARGA[0].numero } },
    });
    await prisma.raw.contact.updateMany({
      where: { id: contato.id },
      data: { name: 'Renomeada pela tela' },
    });
    const r = await carregar();
    expect(r.jaConcluida).toBeInstanceOf(Date);
    expect(r.criados).toEqual(VAZIA);
    expect(await contagem()).toEqual(COMPLETA);
    expect((await prisma.raw.contact.findUniqueOrThrow({ where: { id: contato.id } })).name).toBe(
      'Renomeada pela tela',
    );
  });

  it('depois de uma interrupção, completa só o que falta, sem duplicar nem alterar o que existe', async () => {
    // o estado de uma carga interrompida: um serviço e a paciente Carla já
    // criados (sem agendamento), e o contato dela renomeado pela tela no meio
    const servico = await comoDono((auth) =>
      app.get(ClinicsServiceCatalog).create(
        auth,
        createClinicsServiceSchema.parse({
          name: SERVICOS_DA_CARGA[0].nome,
          durationMin: SERVICOS_DA_CARGA[0].duracaoMin,
        }),
      ),
    );
    const carla = PACIENTES_DA_CARGA[0];
    const contato = await comoDono((auth) =>
      app
        .get(ContactsService)
        .create(
          auth,
          createContactSchema.parse({ name: 'Carla renomeada pela tela', phones: [carla.numero] }),
        ),
    );
    await comoDono((auth) => app.get(ClinicsPatientsService).create(auth, contato.id));

    const r = await carregar();
    expect(r.pulados).toEqual([]);
    expect(r.criados).toEqual({
      servicos: 2,
      profissionais: 2,
      contatos: 5,
      pacientes: 5,
      agendamentos: 5,
      retornos: 1,
    });
    expect(await contagem()).toEqual(COMPLETA);
    // o que existia ficou como estava
    expect((await prisma.raw.contact.findUniqueOrThrow({ where: { id: contato.id } })).name).toBe(
      'Carla renomeada pela tela',
    );
    expect(
      await prisma.raw.clinicsService.count({ where: { name: SERVICOS_DA_CARGA[0].nome } }),
    ).toBe(1);
    expect(
      (await prisma.raw.clinicsService.findUniqueOrThrow({ where: { id: servico.id } })).priceCents,
    ).toBeNull();
  });

  it('o agendamento remarcado e o catálogo mudado pela tela antes da reexecução ficam como estão', async () => {
    // uma carga interrompida no fim: simulada pela carga inteira sem o marcador
    await carregar();
    await prisma.raw.auditLog.deleteMany({ where: { action: MARCADOR_DA_CARGA } });
    // pela tela: a Carla remarcada (outro horário) e um serviço renomeado
    const carla = await prisma.raw.contact.findFirstOrThrow({
      where: { phonesNormalized: { has: PACIENTES_DA_CARGA[0].numero } },
    });
    const pacienteCarla = await prisma.raw.clinicsPatient.findFirstOrThrow({
      where: { contactId: carla.id },
    });
    const agendamento = await prisma.raw.clinicsAppointment.findFirstOrThrow({
      where: { patientId: pacienteCarla.id },
    });
    const dia = agendamento.startsAt.toISOString().slice(0, 10);
    await comoDono((auth) =>
      app.get(ClinicsAppointmentsService).reschedule(auth, agendamento.id, {
        date: dia,
        time: '16:00',
      }),
    );
    await prisma.raw.clinicsService.updateMany({
      where: { name: SERVICOS_DA_CARGA[2].nome },
      data: { name: 'Avaliação (renomeada pela tela)' },
    });

    const r = await carregar();
    expect(r.criados).toEqual(VAZIA);
    // com o catálogo mudado, o que dependeria dele também fica de fora
    expect(r.pulados).toEqual([
      'o catálogo: há serviço ou profissional fora do plano (criado ou renomeado pela tela)',
      'os agendamentos e o retorno: o catálogo foi mudado pela tela',
    ]);
    expect(await contagem()).toEqual(COMPLETA);
    const depois = await prisma.raw.clinicsAppointment.findMany({
      where: { patientId: pacienteCarla.id },
    });
    expect(depois).toHaveLength(1);
    expect(depois[0].startsAt.getTime()).not.toBe(agendamento.startsAt.getTime());
    expect(
      await prisma.raw.clinicsService.count({ where: { name: SERVICOS_DA_CARGA[2].nome } }),
    ).toBe(0);
    // a carga terminou de novo: o marcador volta, e a próxima não faz nada
    expect((await carregar()).jaConcluida).toBeInstanceOf(Date);
  });

  it('a recusa de um item não trava a carga: a profissional arquivada pela tela deixa os agendamentos dela de fora, com o motivo', async () => {
    // uma carga interrompida depois do catálogo (criado como a carga o cria) e,
    // pela tela, a "Dra. Beatriz Fictícia" arquivada no meio
    const unidade = await prisma.raw.clinicsUnit.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId },
    });
    const ids = new Map<string, string>();
    await comoDono(async (auth) => {
      for (const sv of SERVICOS_DA_CARGA) {
        const criado = await app
          .get(ClinicsServiceCatalog)
          .create(
            auth,
            createClinicsServiceSchema.parse({ name: sv.nome, durationMin: sv.duracaoMin }),
          );
        ids.set(sv.nome, criado.id);
      }
      for (const p of PROFISSIONAIS_DA_CARGA) {
        const criado = await app.get(ClinicsProfessionalsService).create(auth, {
          name: p.nome,
          serviceIds: p.servicos.map((i) => ids.get(SERVICOS_DA_CARGA[i].nome) as string),
          intervals: EXPEDIENTE_DA_CARGA.dias.map((weekday) => ({
            unitId: unidade.id,
            weekday,
            startMinute: EXPEDIENTE_DA_CARGA.inicio,
            endMinute: EXPEDIENTE_DA_CARGA.fim,
          })),
        });
        ids.set(p.nome, criado.id);
      }
      await app
        .get(ClinicsProfessionalsService)
        .setArchived(auth, ids.get(PROFISSIONAIS_DA_CARGA[1].nome) as string, true);
    });

    const r = await carregar();
    // a Beatriz atende o Diego e o Fábio: os dois agendamentos ficam de fora
    expect(r.pulados).toHaveLength(2);
    expect(r.pulados[0]).toMatch(/^o agendamento de Diego Demonstração: /);
    expect(r.pulados[1]).toMatch(/^o agendamento de Fábio Demonstração: /);
    expect(r.criados).toEqual({ ...COMPLETA, servicos: 0, profissionais: 0, agendamentos: 3 });
    // a carga terminou, com o que foi pulado: a próxima não faz nada
    expect((await carregar()).jaConcluida).toBeInstanceOf(Date);
  });

  it('o marcador de OUTRO workspace não conta (P0); a trilha marca cada registro da carga', async () => {
    await app.get(ClinicsActivationService).enable('beta');
    await prisma.raw.auditLog.create({
      data: {
        workspaceId: wsB.workspaceId,
        action: MARCADOR_DA_CARGA,
        entityType: 'clinicsDemoLoad',
        entityId: wsB.workspaceId,
        actorType: 'system',
        actorId: 'teste',
      },
    });
    const r = await carregar();
    expect(r.jaConcluida).toBeNull();
    expect(await contagem()).toEqual(COMPLETA);
    // cada registro da carga leva a marca dela no requestId, a mesma na execução
    const trilha = await prisma.raw.auditLog.findMany({
      where: {
        workspaceId: wsA.workspaceId,
        entityType: { in: ['clinicsService', 'clinicsAppointment', 'clinicsPatient'] },
      },
    });
    expect(trilha.length).toBeGreaterThan(0);
    const marcas = new Set(trilha.map((t) => t.requestId));
    expect(marcas.size).toBe(1);
    expect([...marcas][0]).toMatch(/^cli:demo-carregar:[0-9a-f-]{36}$/);
  });

  it('a reexecução sem o marcador, com o catálogo intacto, não duplica agendamento nem retorno', async () => {
    await carregar();
    // a carga "interrompida" no último passo: tudo criado, sem o marcador
    await prisma.raw.auditLog.deleteMany({ where: { action: MARCADOR_DA_CARGA } });
    const r = await carregar();
    expect(r).toEqual({ jaConcluida: null, criados: VAZIA, pulados: [] });
    expect(await contagem()).toEqual(COMPLETA);
  });

  it('com um serviço criado pela tela no catálogo, os pacientes nascem, mas sem agendamento nem retorno', async () => {
    // o catálogo do plano já existe, e a tela acrescentou um serviço a mais
    // antes da primeira carga chegar aos pacientes
    const unidade = await prisma.raw.clinicsUnit.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId },
    });
    await comoDono(async (auth) => {
      const ids = new Map<string, string>();
      for (const sv of SERVICOS_DA_CARGA) {
        const criado = await app
          .get(ClinicsServiceCatalog)
          .create(
            auth,
            createClinicsServiceSchema.parse({ name: sv.nome, durationMin: sv.duracaoMin }),
          );
        ids.set(sv.nome, criado.id);
      }
      for (const p of PROFISSIONAIS_DA_CARGA) {
        await app.get(ClinicsProfessionalsService).create(auth, {
          name: p.nome,
          serviceIds: p.servicos.map((i) => ids.get(SERVICOS_DA_CARGA[i].nome) as string),
          intervals: EXPEDIENTE_DA_CARGA.dias.map((weekday) => ({
            unitId: unidade.id,
            weekday,
            startMinute: EXPEDIENTE_DA_CARGA.inicio,
            endMinute: EXPEDIENTE_DA_CARGA.fim,
          })),
        });
      }
      await app.get(ClinicsServiceCatalog).create(
        auth,
        createClinicsServiceSchema.parse({
          name: 'Massagem (criada pela tela)',
          durationMin: 30,
        }),
      );
    });

    const r = await carregar();
    expect(r.pulados).toEqual([
      'o catálogo: há serviço ou profissional fora do plano (criado ou renomeado pela tela)',
      'os agendamentos e o retorno: o catálogo foi mudado pela tela',
    ]);
    expect(r.criados).toEqual({ ...VAZIA, contatos: 6, pacientes: 6 });
    expect(await prisma.raw.clinicsAppointment.count()).toBe(0);
    expect(await prisma.raw.clinicsReturn.count()).toBe(0);
  });
});
