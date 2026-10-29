import type { INestApplication } from '@nestjs/common';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  TEST_PASSWORD,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { RESPOSTA_DA_MANUTENCAO } from './manutencao';

/**
 * A barreira de manutenção na app real (ADR-053): com ela ligada, toda
 * requisição recebe 503 ANTES de cookie, corpo, autenticação e banco — o login
 * com a senha certa não cria sessão, o webhook não grava nada — e só a saúde
 * pelo socket de loopback responde. Pelo endereço da rede, até a saúde é 503.
 */

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

/** Um endereço IPv4 desta máquina que NÃO é loopback (o da rede). */
function enderecoDaRede(): string | null {
  for (const lista of Object.values(networkInterfaces())) {
    for (const i of lista ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

describe('ADR-053 — a barreira de manutenção (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp([], [], { manutencao: true });
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const ws = await createWorkspaceFixture(prisma, 'acme');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    await createMembershipFixture(prisma, ws.workspaceId, dono, ws.roles.owner);
  });

  const barrada = (res: request.Response) => {
    expect(res.status).toBe(503);
    expect(res.body).toEqual(RESPOSTA_DA_MANUTENCAO);
    expect(res.headers['retry-after']).toBe('300');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  };

  it('a saúde pelo loopback responde; o HEAD dela, não', async () => {
    await request(http).get('/api/health').expect(200);
    // o HEAD não tem corpo (é o HTTP): o status e os cabeçalhos bastam
    const head = await request(http).head('/api/health');
    expect(head.status).toBe(503);
    expect(head.headers['retry-after']).toBe('300');
  });

  it('o login com a senha certa é 503 e não cria sessão nem lê o corpo', async () => {
    const antes = await prisma.raw.refreshToken.count();
    barrada(
      await request(http)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'dono@veyra.test', password: TEST_PASSWORD }),
    );
    // corpo inválido também é 503, não 400: a barreira vem antes do parser
    barrada(
      await request(http)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{isto não é json'),
    );
    expect(await prisma.raw.refreshToken.count()).toBe(antes);
  });

  it('o webhook da Meta, a rota autenticada, a inexistente e o OPTIONS do CORS: todos 503, sem gravar nada', async () => {
    const mensagens = await prisma.raw.message.count();
    barrada(
      await request(http)
        .post('/api/channels/whatsapp/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ object: 'whatsapp_business_account', entry: [] })),
    );
    barrada(await request(http).get('/api/contacts'));
    barrada(await request(http).get('/api/nao-existe'));
    barrada(
      await request(http)
        .options('/api/auth/login')
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'POST'),
    );
    expect(await prisma.raw.message.count()).toBe(mensagens);
  });

  it('pelo endereço da rede, até a saúde é 503 — e o X-Forwarded-For de loopback não muda nada', async () => {
    const ip = enderecoDaRede();
    if (!ip) {
      // sem interface de rede não há como sair do loopback. Pular em silêncio
      // seria um verde falso: só a recusa EXPLÍCITA dispensa o teste
      if (process.env.VEYRA_TESTE_SEM_REDE === '1') return;
      throw new Error(
        'sem endereço IPv4 de rede nesta máquina: o teste pela rede não roda (VEYRA_TESTE_SEM_REDE=1 dispensa, de propósito)',
      );
    }
    // a MESMA app, escutando também no endereço da rede
    const servidor: Server = createServer(app.getHttpAdapter().getInstance());
    await new Promise<void>((resolve) => servidor.listen(0, ip, resolve));
    const porta = (servidor.address() as { port: number }).port;
    try {
      const resposta = await new Promise<{ status: number; corpo: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: ip,
            port: porta,
            path: '/api/health',
            method: 'GET',
            headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
          },
          (res) => {
            let corpo = '';
            res.on('data', (pedaco) => (corpo += pedaco));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(resposta.status).toBe(503);
      expect(JSON.parse(resposta.corpo)).toEqual(RESPOSTA_DA_MANUTENCAO);
    } finally {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
    }
  });
});
