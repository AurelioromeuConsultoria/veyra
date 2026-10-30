import { INestApplication } from '@nestjs/common';
import { SESSION_SCOPE_HEADER, sessionScopeKey } from '@veyra/contracts';
import request from 'supertest';
import { createTestApp } from '../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  TEST_PASSWORD,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

/**
 * As notificações numa sessão SEM workspace ativo (ADR-055 adendo 1, item 7).
 * Para o guard, a conta que nunca teve workspace e a membership removida e
 * renovada pelo refresh são a mesma coisa: a sessão sem membership. A caixa é
 * vazia, "marcar uma" não acha nada (404) e "marcar todas" marca zero — nunca
 * o 500 da proteção multitenant, que antes respondia aqui. Com workspace, uma
 * falha de verdade continua sendo falha: a lista vazia é só para a ausência
 * de workspace.
 */
describe('Notificações sem workspace ativo (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
  });

  it('caixa vazia, contagem zero e "marcar" sem efeito — sem 500', async () => {
    await createUserFixture(prisma, 'sem-workspace@veyra.test');
    const entrada = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'sem-workspace@veyra.test', password: TEST_PASSWORD })
      .expect(201);
    expect(entrada.body.activeMembership).toBeNull();
    expect(entrada.body.experience).toBeNull();
    const cookies = ((entrada.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const csrf = /veyra_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';

    const lista = await request(http).get('/api/notifications').set('Cookie', cookies).expect(200);
    expect(lista.body).toEqual({ items: [], unreadCount: 0 });
    // o escopo da sessão sem workspace é o mesmo que o web calcula (`u:-:-`)
    expect(lista.headers[SESSION_SCOPE_HEADER]).toBe(sessionScopeKey(entrada.body.id, null, null));
    await request(http)
      .post('/api/notifications/read-all')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .expect(201)
      .expect({ marked: 0 });
    await request(http)
      .patch('/api/notifications/00000000-0000-4000-8000-000000000001/read')
      .set('Origin', ORIGIN)
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .expect(404);
  });

  it('com workspace, uma falha real da consulta é erro — não vira lista vazia', async () => {
    const fixture = await createWorkspaceFixture(prisma, 'acme');
    const userId = await createUserFixture(prisma, 'com-workspace@veyra.test');
    await createMembershipFixture(prisma, fixture.workspaceId, userId, fixture.roles.member);
    const entrada = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'com-workspace@veyra.test', password: TEST_PASSWORD })
      .expect(201);
    const cookies = ((entrada.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const espia = jest
      .spyOn(app.get(NotificationsService), 'list')
      .mockRejectedValueOnce(new Error('consulta falhou'));
    try {
      const res = await request(http).get('/api/notifications').set('Cookie', cookies);
      expect(res.status).toBe(500);
      expect(res.body).not.toEqual({ items: [], unreadCount: 0 });
    } finally {
      espia.mockRestore();
    }
  });
});
