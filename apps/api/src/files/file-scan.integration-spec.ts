import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { FileScanService } from './file-scan.service';
import { FilesService } from './files.service';
import { UsageService } from '../usage/usage.service';
import { FILE_SCANNER, type FileScanner, type ScanVerdict } from './file-scanner';
import { STORAGE_DRIVER, type StorageDriver } from './storage.driver';

/** Scanner FALSO: nenhuma suíte depende de ClamAV instalado (ADR-043). */
class FakeScanner implements FileScanner {
  next: ScanVerdict = { status: 'clean' };
  chamadas = 0;
  async scan(): Promise<ScanVerdict> {
    this.chamadas += 1;
    return this.next;
  }
}

/** Storage em memória, com falha de remoção sob comando. */
class FakeStorage implements StorageDriver {
  arquivos = new Map<string, Buffer>();
  falharDelete = false;
  /** simula driver que "não lança" mas também não remove (rm -f no vazio) */
  deleteSilenciosoSemRemover = false;

  async put(key: string, bytes: Buffer) {
    this.arquivos.set(key, bytes);
  }
  async get(key: string) {
    const b = this.arquivos.get(key);
    if (!b) throw new Error('ausente');
    return b;
  }
  async delete(key: string) {
    if (this.falharDelete) throw new Error('ErroDeStorage');
    if (this.deleteSilenciosoSemRemover) return;
    this.arquivos.delete(key);
  }
  async exists(key: string) {
    return this.arquivos.has(key);
  }
}

/** Quota que falha sob comando, para provar a atomicidade da contabilidade. */
class FakeUsage {
  falharDecremento = false;
  constructor(private readonly real: UsageService) {}
  async consumeOverLimit(...args: Parameters<UsageService['consumeOverLimit']>): Promise<void> {
    if (this.falharDecremento) throw new Error('QuotaIndisponivel');
    return this.real.consumeOverLimit(...args);
  }
  async ensureCounterRow(...args: Parameters<UsageService['ensureCounterRow']>): Promise<void> {
    return this.real.ensureCounterRow(...args);
  }
}

/** Auditoria que falha sob comando, para provar a atomicidade da quarentena. */
class FakeAudit {
  falhar = false;
  constructor(private readonly real: AuditService) {}
  async record(...args: Parameters<AuditService['record']>): Promise<void> {
    if (this.falhar) throw new Error('AuditoriaIndisponivel');
    return this.real.record(...args);
  }
}

describe('Varredura de arquivos e quarentena (ADR-043)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wsA: WorkspaceFixture;
  let membershipId: string;
  const scanner = new FakeScanner();
  const storage = new FakeStorage();
  let audit: FakeAudit;
  let usage: FakeUsage;

  beforeAll(async () => {
    // sobe uma vez só para obter o AuditService REAL, e reabre com o dublê que
    // o embrulha: a falha precisa ser da auditoria, não de uma reimplementação
    const base = await createTestApp();
    audit = new FakeAudit(base.get(AuditService));
    usage = new FakeUsage(base.get(UsageService));
    await base.close();

    app = await createTestApp(
      [],
      [
        { provide: FILE_SCANNER, useValue: scanner },
        { provide: STORAGE_DRIVER, useValue: storage },
        { provide: AuditService, useValue: audit },
        { provide: UsageService, useValue: usage },
      ],
    );
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  const authDe = (ws: WorkspaceFixture) =>
    ({
      userId: 'u',
      email: 'owner-a@veyra.test',
      membershipId,
      workspaceId: ws.workspaceId,
      sessionId: 's',
    }) as never;

  const criarArquivo = async (nome = 'exame.pdf', sizeBytes = 8) => {
    const chave = `${wsA.workspaceId}/${nome}`;
    await storage.put(chave, Buffer.from('conteudo'));
    const row = await prisma.raw.fileObject.create({
      data: {
        workspaceId: wsA.workspaceId,
        key: chave,
        fileName: nome,
        mimeType: 'application/pdf',
        sizeBytes,
        uploadedByMembershipId: membershipId,
      },
    });
    return row;
  };

  beforeEach(async () => {
    scanner.next = { status: 'clean' };
    scanner.chamadas = 0;
    storage.arquivos.clear();
    storage.falharDelete = false;
    storage.deleteSilenciosoSemRemover = false;
    audit.falhar = false;
    usage.falharDecremento = false;

    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const owner = await createUserFixture(prisma, 'owner-a@veyra.test');
    membershipId = await createMembershipFixture(prisma, wsA.workspaceId, owner, wsA.roles.owner);
  });

  it('arquivo limpo vira `clean` e os bytes PERMANECEM', async () => {
    const arquivo = await criarArquivo();

    const resultado = await app.get(FileScanService).scanPending();

    expect(resultado).toMatchObject({ clean: 1, quarantined: 0 });
    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(depois).toMatchObject({ scanStatus: 'clean', bytesPurgedAt: null });
    expect(depois?.scannedAt).not.toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(true);
  });

  it('P0: infectado vira quarentena TERMINAL, com linha preservada e bytes removidos', async () => {
    scanner.next = { status: 'infected', threat: 'Eicar-Test-Signature' };
    const arquivo = await criarArquivo('boleto.pdf');

    await app.get(FileScanService).scanPending();

    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    /**
     * A LINHA permanece — é a evidência de que o arquivo existiu e foi barrado;
     * apagá-la tornaria o sumiço indistinguível de bug. Os BYTES saem, porque
     * malware guardado é passivo sem contrapartida (o download já é bloqueado).
     */
    expect(depois).not.toBeNull();
    expect(depois).toMatchObject({ scanStatus: 'quarantined', scanError: 'Eicar-Test-Signature' });
    expect(depois?.bytesPurgedAt).not.toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(false);

    // e a quarentena deixa trilha, sem nome de ameaça virar conteúdo livre
    const trilha = await prisma.raw.auditLog.findFirst({
      where: { workspaceId: wsA.workspaceId, action: 'file.quarantined' },
    });
    expect(trilha?.entityId).toBe(arquivo.id);
  });

  it('P0: remoção que FALHA não desfaz a quarentena nem volta para pending', async () => {
    scanner.next = { status: 'infected', threat: 'Trojan.Generic' };
    storage.falharDelete = true;
    const arquivo = await criarArquivo();

    await app.get(FileScanService).scanPending();

    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    /**
     * O estado "quarentena com bytes no disco" é VÁLIDO e observável. O inverso
     * — banco dizendo `pending` com o arquivo já removido — é o que a ordem
     * (registrar, depois apagar) impede.
     */
    expect(depois).toMatchObject({ scanStatus: 'quarantined', bytesPurgedAt: null });
    expect(storage.arquivos.has(arquivo.key)).toBe(true);

    // e o job idempotente conclui a limpeza quando o storage volta
    storage.falharDelete = false;
    expect(await app.get(FileScanService).purgeQuarantinedBytes()).toBe(1);
    const limpo = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(limpo?.bytesPurgedAt).not.toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(false);
  });

  it('P0: driver que NÃO REMOVE sem lançar não conta como limpeza concluída', async () => {
    scanner.next = { status: 'infected', threat: 'Trojan.Generic' };
    // é o comportamento do `rm(force: true)`: silencioso mesmo sem apagar
    storage.deleteSilenciosoSemRemover = true;
    const arquivo = await criarArquivo();

    await app.get(FileScanService).scanPending();

    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    // "não lançou" não é prova: a confirmação é `exists` devolver falso
    expect(depois?.bytesPurgedAt).toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(true);
  });

  it('P1: indisponibilidade NÃO vira estado terminal — scanner volta e o arquivo é escaneado', async () => {
    scanner.next = { status: 'unavailable', reason: 'no_scanner' };
    const arquivo = await criarArquivo('exame-longo.pdf');
    const service = app.get(FileScanService);

    /**
     * Sem ClamAV, cinco ciclos consumiam as tentativas e o arquivo saía da fila
     * PARA SEMPRE — `pending` permanente, invisível, e nunca mais verificado nem
     * com o scanner de volta. Indisponibilidade não é culpa do arquivo.
     */
    for (let i = 0; i < 6; i += 1) {
      await service.scanPending();
      // o backoff adia o próximo ciclo; o teste adianta o relógio DO BANCO
      await prisma.raw.$executeRawUnsafe(
        `UPDATE "FileObject" SET "scanLeaseExpiresAt" = now() - interval '1 minute'
          WHERE "id" = $1::uuid`,
        arquivo.id,
      );
    }
    const noLimbo = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(noLimbo).toMatchObject({ scanStatus: 'pending', scanError: 'no_scanner' });
    // tentativas devolvidas: o teto é para ciclo INTERROMPIDO, não para o scanner fora
    expect(noLimbo?.scanAttempts).toBe(0);

    scanner.next = { status: 'clean' };
    const resultado = await service.scanPending();

    expect(resultado).toMatchObject({ clean: 1 });
    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(depois?.scanStatus).toBe('clean');
  });

  it('P1: falha da AUDITORIA desfaz a quarentena inteira — nada muda, bytes ficam', async () => {
    scanner.next = { status: 'infected', threat: 'Eicar-Test-Signature' };
    const arquivo = await criarArquivo('malware.pdf');
    audit.falhar = true;

    await app.get(FileScanService).scanPending();

    /**
     * Estado e evidência são a mesma transação: se a trilha falha, o arquivo NÃO
     * pode ficar `quarantined` sem ela — evidência incompleta parece completa.
     * E os bytes só saem depois do commit, então continuam no lugar.
     */
    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(depois?.scanStatus).toBe('pending');
    expect(depois?.bytesPurgedAt).toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(true);
    expect(await prisma.raw.auditLog.count({ where: { action: 'file.quarantined' } })).toBe(0);

    // e o arquivo volta a ser processável quando a auditoria se recupera
    audit.falhar = false;
    usage.falharDecremento = false;
    await prisma.raw.$executeRawUnsafe(
      `UPDATE "FileObject" SET "scanLeaseExpiresAt" = now() - interval '1 minute'
        WHERE "id" = $1::uuid`,
      arquivo.id,
    );
    await app.get(FileScanService).scanPending();

    const enfim = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(enfim?.scanStatus).toBe('quarantined');
    expect(enfim?.bytesPurgedAt).not.toBeNull();
    expect(storage.arquivos.has(arquivo.key)).toBe(false);
  });

  it('P1: quarentena DEVOLVE a quota de armazenamento dos bytes destruídos', async () => {
    scanner.next = { status: 'infected', threat: 'Eicar-Test-Signature' };
    const usage = app.get(UsageService);
    await usage.ensureCounterRow(wsA.workspaceId, 'storage_bytes');
    await prisma.raw.usageCounter.updateMany({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
      data: { value: BigInt(1024) },
    });
    await criarArquivo('grande.pdf', 1024);

    await app.get(FileScanService).scanPending();

    /**
     * `storage_bytes` é gauge COBRADO: sem devolver, o workspace pagaria para
     * sempre por bytes destruídos, e alguns arquivos infectados consumiriam o
     * teto sem ocupar um byte real.
     */
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contador?.value ?? -1)).toBe(0);
  });

  it('P1: falha da QUOTA depois de apagar os bytes deixa a limpeza PENDENTE', async () => {
    scanner.next = { status: 'infected', threat: 'Eicar-Test-Signature' };
    const real = app.get(UsageService) as unknown as FakeUsage;
    await usage.ensureCounterRow(wsA.workspaceId, 'storage_bytes');
    await prisma.raw.usageCounter.updateMany({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
      data: { value: BigInt(1024) },
    });
    const arquivo = await criarArquivo('infectado.pdf', 1024);
    real.falharDecremento = true;

    await app.get(FileScanService).scanPending();

    /**
     * Os bytes JÁ saíram — e é a confirmação de ausência, não a marca, que
     * permite retentar. Se `bytesPurgedAt` ficasse gravado com a quota falhando,
     * o arquivo sairia da fila e o workspace pagaria para sempre por bytes que
     * não existem.
     */
    const meio = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(meio).toMatchObject({ scanStatus: 'quarantined', bytesPurgedAt: null });
    expect(storage.arquivos.has(arquivo.key)).toBe(false);
    const contadorMeio = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contadorMeio?.value ?? 0)).toBe(1024); // ainda não devolvido

    // quota volta: o ciclo seguinte conclui a limpeza e devolve UMA vez
    real.falharDecremento = false;
    expect(await app.get(FileScanService).purgeQuarantinedBytes()).toBe(1);
    expect(await app.get(FileScanService).purgeQuarantinedBytes()).toBe(0);

    const fim = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(fim?.bytesPurgedAt).not.toBeNull();
    const contadorFim = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contadorFim?.value ?? -1)).toBe(0); // exatamente uma devolução
  });

  it('quarentena NÃO pode ser excluída: a linha é a evidência', async () => {
    scanner.next = { status: 'infected', threat: 'X' };
    const arquivo = await criarArquivo();
    await app.get(FileScanService).scanPending();

    // qualquer um com `files:delete` destruiria o registro do incidente
    const cls = app.get(ClsService);
    await expect(
      cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        return app.get(FilesService).remove(authDe(wsA), arquivo.id);
      }),
    ).rejects.toThrow(/quarentena/i);
    expect(await prisma.raw.fileObject.count({ where: { id: arquivo.id } })).toBe(1);
  });

  it('exclusão que corre com a quarentena não destrói a evidência (TOCTOU)', async () => {
    const arquivo = await criarArquivo();
    const cls = app.get(ClsService);

    /**
     * A guarda lê o status e só depois apaga. Simulo a quarentena comitando
     * NESSA janela: sem o predicado no próprio DELETE, a linha-evidência sumiria
     * apesar da checagem ter passado.
     */
    await prisma.raw.$executeRawUnsafe(
      `UPDATE "FileObject" SET "scanStatus" = 'quarantined', "scannedAt" = now()
        WHERE "id" = $1::uuid`,
      arquivo.id,
    );

    await expect(
      cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        return app.get(FilesService).remove(authDe(wsA), arquivo.id);
      }),
    ).rejects.toThrow(/quarentena/i);
    expect(await prisma.raw.fileObject.count({ where: { id: arquivo.id } })).toBe(1);
  });

  it('P0: cada workspace fica com a SUA quarentena e a sua trilha', async () => {
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    const membershipB = await createMembershipFixture(
      prisma,
      wsB.workspaceId,
      ownerB,
      wsB.roles.owner,
    );
    const chaveB = `${wsB.workspaceId}/limpo.pdf`;
    await storage.put(chaveB, Buffer.from('conteudo'));
    const arquivoB = await prisma.raw.fileObject.create({
      data: {
        workspaceId: wsB.workspaceId,
        key: chaveB,
        fileName: 'limpo.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
        uploadedByMembershipId: membershipB,
      },
    });
    scanner.next = { status: 'infected', threat: 'SoDoA' };
    const arquivoA = await criarArquivo('infectado-a.pdf');

    // o lote pega os dois; o de B é escaneado no mesmo ciclo
    await app.get(FileScanService).scanPending();

    /**
     * O dublê devolve o mesmo veredito para todos, então os DOIS arquivos vão
     * para quarentena — e é isso que torna a prova forte: cada trilha tem de
     * ficar com o SEU dono. Uma varredura cross-workspace que embaralhasse
     * workspaceId escreveria a evidência de um tenant na conta do outro.
     */
    const trilha = await prisma.raw.auditLog.findMany({ where: { action: 'file.quarantined' } });
    expect(trilha).toHaveLength(2);
    const porArquivo = new Map(trilha.map((linha) => [linha.entityId, linha.workspaceId]));
    expect(porArquivo.get(arquivoA.id)).toBe(wsA.workspaceId);
    expect(porArquivo.get(arquivoB.id)).toBe(wsB.workspaceId);
    // e cada linha ficou no seu workspace
    const bDepois = await prisma.raw.fileObject.findFirst({ where: { id: arquivoB.id } });
    expect(bDepois?.workspaceId).toBe(wsB.workspaceId);
    expect(bDepois?.scanStatus).toBe('quarantined');
  });

  it('o banco recusa estados incoerentes de scan', async () => {
    const arquivo = await criarArquivo();
    // bytes removidos só existem em quarentena
    await expect(
      prisma.raw.$executeRawUnsafe(
        `UPDATE "FileObject" SET "bytesPurgedAt" = now() WHERE "id" = $1::uuid`,
        arquivo.id,
      ),
    ).rejects.toThrow(/purge_only_quarantined/);
    // veredito exige estado terminal
    await expect(
      prisma.raw.$executeRawUnsafe(
        `UPDATE "FileObject" SET "scannedAt" = now() WHERE "id" = $1::uuid`,
        arquivo.id,
      ),
    ).rejects.toThrow(/verdict_requires_terminal/);
  });

  it('P1: dois ciclos de limpeza CONCORRENTES devolvem a quota uma única vez', async () => {
    scanner.next = { status: 'infected', threat: 'X' };
    const real = app.get(UsageService) as unknown as FakeUsage;
    await usage.ensureCounterRow(wsA.workspaceId, 'storage_bytes');
    await prisma.raw.usageCounter.updateMany({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
      data: { value: BigInt(2048) },
    });
    // quarentena com a contabilidade FALHANDO: bytes saem, marca não é gravada
    real.falharDecremento = true;
    await criarArquivo('duplo.pdf', 1024);
    await app.get(FileScanService).scanPending();
    real.falharDecremento = false;

    /**
     * `purgeQuarantinedBytes` NÃO pega lease: duas instâncias da API selecionam
     * o mesmo arquivo no mesmo minuto, rotineiramente. O que impede o estorno
     * dobrado é o `bytesPurgedAt IS NULL` DENTRO da transação do decremento —
     * sem ele o gauge cairia duas vezes e, com o clamp em zero, o workspace
     * inteiro pararia de contar armazenamento.
     */
    const service = app.get(FileScanService);
    const [a, b] = await Promise.all([
      service.purgeQuarantinedBytes(),
      service.purgeQuarantinedBytes(),
    ]);

    expect(a + b).toBe(1); // um só concluiu
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contador?.value ?? -1)).toBe(1024); // 2048 - 1024, uma vez só
  });

  it('bytes AUSENTES no storage não viram veredito limpo', async () => {
    // objeto sumiu do storage: sem leitura não há veredito, e `clean` aqui
    // liberaria para canal externo um arquivo que ninguém verificou
    const orfao = await prisma.raw.fileObject.create({
      data: {
        workspaceId: wsA.workspaceId,
        key: `${wsA.workspaceId}/sumido.pdf`,
        fileName: 'sumido.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
        uploadedByMembershipId: membershipId,
      },
    });

    await app.get(FileScanService).scanPending();

    const depois = await prisma.raw.fileObject.findFirst({ where: { id: orfao.id } });
    expect(depois).toMatchObject({ scanStatus: 'pending', scanError: 'bytes_unreadable' });
    expect(depois?.scannedAt).toBeNull();
  });

  it('scanner INDISPONÍVEL não vira veredito: arquivo segue pending', async () => {
    scanner.next = { status: 'unavailable', reason: 'no_scanner' };
    const arquivo = await criarArquivo();

    await app.get(FileScanService).scanPending();

    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    /**
     * Sem scanner o arquivo NÃO é liberado: `pending` já não sai para canal
     * externo. A ausência degrada para o seguro, nunca para "clean".
     */
    expect(depois).toMatchObject({ scanStatus: 'pending', scanError: 'no_scanner' });
    expect(depois?.scannedAt).toBeNull();
    expect(depois?.scanClaimToken).toBeNull(); // lease devolvido
  });

  it('dois ciclos concorrentes escaneiam o arquivo UMA vez', async () => {
    const arquivo = await criarArquivo();
    const service = app.get(FileScanService);

    await Promise.all([service.scanPending(), service.scanPending()]);

    expect(scanner.chamadas).toBe(1);
    const depois = await prisma.raw.fileObject.findFirst({ where: { id: arquivo.id } });
    expect(depois).toMatchObject({ scanStatus: 'clean', scanAttempts: 1 });
  });

  it('quarentena não é reprocessada por nova varredura', async () => {
    scanner.next = { status: 'infected', threat: 'X' };
    await criarArquivo();
    await app.get(FileScanService).scanPending();
    scanner.chamadas = 0;

    await app.get(FileScanService).scanPending();

    // terminal: o claim só enxerga `pending`
    expect(scanner.chamadas).toBe(0);
  });
});
