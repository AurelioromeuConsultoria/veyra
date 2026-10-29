import type { INestApplication } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import { createWorkspaceFixture, seedPermissionCatalog } from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import type { INestApplicationContext } from '@nestjs/common';
import {
  AVISO_DE_TOKEN_EXPOSTO,
  cadastrarCanalWhatsapp,
  executarCadastroDoCanal,
  RecusaDoCanal,
  USO_DO_CANAL,
} from './channel-whatsapp.core';

/**
 * O cadastro do canal WhatsApp compilado (F4.4c, ADR-048 adendo 13): as regras
 * do script que ele substitui — criar, rotacionar, recusar o número de outro
 * workspace e a troca de WABA sem confirmação —, com o token cifrado pelo
 * `CryptoService` e nunca devolvido nem em recusa. Ids e tokens FICTÍCIOS.
 */

const TOKEN = 'token-ficticio-do-teste-de-canal';

describe('F4.4c — o cadastro do canal WhatsApp, compilado (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    await createWorkspaceFixture(prisma, 'acme');
    await createWorkspaceFixture(prisma, 'beta');
  });

  const cadastrar = (extra: Partial<Parameters<typeof cadastrarCanalWhatsapp>[1]> = {}) =>
    cadastrarCanalWhatsapp(app, {
      slug: 'acme',
      phoneNumberId: '000000000000011',
      businessAccountId: '000000000000100',
      nome: 'WhatsApp da demonstração',
      token: TOKEN,
      trocarWaba: false,
      ...extra,
    });
  const credenciais = () =>
    prisma.raw.channelCredential.findMany({ orderBy: { createdAt: 'asc' } });

  it('cria o canal e a credencial, com o token cifrado que o CryptoService decifra', async () => {
    const r = await cadastrar();
    expect(r.tipo).toBe('criado');
    const canal = await prisma.raw.channel.findUniqueOrThrow({ where: { id: r.channelId } });
    expect(canal).toMatchObject({ type: 'whatsapp', name: 'WhatsApp da demonstração' });
    const [credencial] = await credenciais();
    expect(credencial).toMatchObject({
      channelId: r.channelId,
      phoneNumberId: '000000000000011',
      businessAccountId: '000000000000100',
    });
    expect(credencial.tokenCipher).not.toContain(TOKEN);
    expect(app.get(CryptoService).decrypt(credencial.tokenCipher)).toBe(TOKEN);
    // o client protegido carimbou o workspace do slug, e o outro ficou vazio (P0)
    const acme = await prisma.raw.workspace.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(canal.workspaceId).toBe(acme.id);
    expect(credencial.workspaceId).toBe(acme.id);
    const beta = await prisma.raw.workspace.findUniqueOrThrow({ where: { slug: 'beta' } });
    expect(
      await prisma.raw.channel.count({ where: { workspaceId: beta.id, type: 'whatsapp' } }),
    ).toBe(0);
    // a trilha: os ids e a origem, nunca o token
    const [trilha] = await prisma.raw.auditLog.findMany({
      where: { action: 'channel.credential_registered' },
    });
    expect(trilha).toMatchObject({ actorType: 'system', actorId: 'cli:channel-whatsapp' });
    expect(trilha.after).toEqual({
      channelId: r.channelId,
      phoneNumberId: '000000000000011',
      businessAccountId: '000000000000100',
      trocouWaba: false,
    });
    expect(trilha.requestId).toMatch(/^cli:channel-whatsapp:[0-9a-f-]{36}$/);
    expect(JSON.stringify(trilha)).not.toContain(TOKEN);
  });

  it('o mesmo número no mesmo workspace rotaciona o token, sem canal novo', async () => {
    const criado = await cadastrar();
    const r = await cadastrar({ token: 'outro-token-ficticio' });
    expect(r).toEqual({ tipo: 'rotacionado', channelId: criado.channelId, trocouWaba: false });
    const lista = await credenciais();
    expect(lista).toHaveLength(1);
    expect(app.get(CryptoService).decrypt(lista[0].tokenCipher)).toBe('outro-token-ficticio');
    expect(await prisma.raw.channel.count({ where: { type: 'whatsapp' } })).toBe(1);
  });

  it('o número de OUTRO workspace é recusado, sem mudar nada (P0: o webhook iria ao tenant errado)', async () => {
    await cadastrar();
    const antes = await credenciais();
    await expect(cadastrar({ slug: 'beta', token: 'token-do-beta' })).rejects.toThrow(
      new RecusaDoCanal(
        'phone-number-id 000000000000011 já está registrado em OUTRO workspace. ' +
          'Remova lá antes, ou o webhook entregaria as mensagens ao tenant errado.',
      ),
    );
    expect(await credenciais()).toEqual(antes);
  });

  it('trocar a WABA exige a confirmação; com ela, a WABA muda', async () => {
    await cadastrar();
    const tentativa = cadastrar({ businessAccountId: '000000000000200', token: 'novo-token' });
    await expect(tentativa).rejects.toThrow(RecusaDoCanal);
    await expect(tentativa).rejects.toThrow(/--trocar-waba/);
    let [credencial] = await credenciais();
    expect(credencial.businessAccountId).toBe('000000000000100');
    expect(app.get(CryptoService).decrypt(credencial.tokenCipher)).toBe(TOKEN);

    const r = await cadastrar({
      businessAccountId: '000000000000200',
      token: 'novo-token',
      trocarWaba: true,
    });
    expect(r).toMatchObject({ tipo: 'rotacionado', trocouWaba: true });
    [credencial] = await credenciais();
    expect(credencial.businessAccountId).toBe('000000000000200');
  });

  it('recusa o workspace inexistente e o token vazio, e nenhuma recusa traz o token', async () => {
    const recusas = [cadastrar({ slug: 'nao-existe' }), cadastrar({ token: '' })].map((p) =>
      p.then(() => null).catch((e: Error) => e),
    );
    for (const erro of await Promise.all(recusas)) {
      expect(erro).toBeInstanceOf(RecusaDoCanal);
      expect((erro as Error).message).not.toContain(TOKEN);
    }
    expect(await credenciais()).toEqual([]);
  });

  describe('a linha de comando', () => {
    /** a CLI com a entrada e a saída capturadas; o app é o do teste, sem fechar */
    const rodar = async (
      argv: string[],
      extra: { entradaEhTerminal?: boolean; entrada?: string } = {},
    ) => {
      const saidas: string[] = [];
      let subiu = false;
      const codigo = await executarCadastroDoCanal({
        argv,
        entradaEhTerminal: extra.entradaEhTerminal ?? false,
        lerEntrada: async () => extra.entrada ?? TOKEN,
        perguntarSemEco: async () => TOKEN,
        criarApp: async () => {
          subiu = true;
          return {
            get: app.get.bind(app),
            close: async () => undefined,
          } as unknown as INestApplicationContext;
        },
        saida: (l) => saidas.push(`out: ${l}`),
        erro: (l) => saidas.push(`err: ${l}`),
      });
      return { codigo, saidas, subiu };
    };
    const BASE = [
      '--slug',
      'acme',
      '--phone-number-id',
      '000000000000011',
      '--waba',
      '000000000000100',
    ];

    it.each([[['--token', 'EAAG-segredo']], [['--token=EAAG-segredo']], [['--tokenEAAG-segredo']]])(
      'o token por argumento (%j) é recusado antes de tudo, com o aviso de rotação',
      async (forma) => {
        const r = await rodar([...BASE, ...forma]);
        expect(r).toMatchObject({ codigo: 1, subiu: false });
        expect(r.saidas).toEqual([`err: ${AVISO_DE_TOKEN_EXPOSTO}`]);
        expect(r.saidas.join('\n')).not.toContain('EAAG-segredo');
        expect(await credenciais()).toEqual([]);
      },
    );

    it('argumento desconhecido, posicional ou faltando: o uso, sem subir nada', async () => {
      for (const argv of [
        [...BASE, '--foo'],
        [...BASE, 'solto'],
        ['--slug', 'acme'],
      ]) {
        const r = await rodar(argv);
        expect(r).toEqual({ codigo: 1, saidas: [`err: ${USO_DO_CANAL}`], subiu: false });
      }
    });

    it('--token-stdin com a entrada no terminal é recusado: o token apareceria na tela', async () => {
      const r = await rodar([...BASE, '--token-stdin'], { entradaEhTerminal: true });
      expect(r).toMatchObject({ codigo: 1, subiu: false });
      expect(r.saidas[0]).toMatch(/^err: RECUSADO: --token-stdin com a entrada padrão no terminal/);
      expect(await credenciais()).toEqual([]);
    });

    it('pelo pipe, cria; nenhuma linha da saída traz o token', async () => {
      const r = await rodar([...BASE, '--token-stdin', '--name', 'WhatsApp da demonstração']);
      expect(r.codigo).toBe(0);
      expect(r.saidas[0]).toMatch(/^out: canal WhatsApp criado para acme: channelId=/);
      expect(r.saidas.join('\n')).not.toContain(TOKEN);
      expect(await credenciais()).toHaveLength(1);
    });

    it('a falha do Prisma mostra só o tipo e o código, nunca a mensagem (que traria o payload)', async () => {
      const falha = Object.assign(new Error(`payload com ${TOKEN}`), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
      });
      const espiao = jest
        .spyOn(prisma.raw.channelCredential, 'findFirst')
        .mockRejectedValueOnce(falha);
      try {
        const r = await rodar([...BASE, '--token-stdin']);
        expect(r.codigo).toBe(1);
        expect(r.saidas).toEqual(['err: falhou: PrismaClientKnownRequestError P2002']);
        expect(r.saidas.join('\n')).not.toContain(TOKEN);
      } finally {
        espiao.mockRestore();
      }
    });
  });
});
