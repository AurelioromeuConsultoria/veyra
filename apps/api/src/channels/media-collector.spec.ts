import { MediaCollectorService } from './media-collector.service';

/**
 * A decisão "este arquivo é resíduo?" tem quatro combinações e uma delas apaga
 * dado bom. Ela não é alcançável pelo fluxo de integração — nada roda depois do
 * COMMIT —, então é aqui que ela fica provada.
 */
describe('descarte de mídia decidido pelo estado persistido (ADR-039)', () => {
  const item = {
    id: 'media-1',
    workspaceId: 'ws-1',
    messageId: 'msg-1',
    providerMediaId: 'prov-1',
    mimeType: 'image/png',
    fileName: 'exame.png',
    attempts: 0,
    claimToken: 'token-1',
  };

  const build = (linha: { state: string; fileObjectId: string | null } | null) => {
    const descartados: string[] = [];
    // ordem do construtor: prisma, crypto, files, usage, cls, transport
    const service = new MediaCollectorService(
      { raw: { inboundMedia: { findFirst: async () => linha } } } as never,
      {} as never,
      { discardOrphan: async (_ws: string, id: string) => void descartados.push(id) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, descartados };
  };

  const descartar = async (linha: { state: string; fileObjectId: string | null } | null) => {
    const { service, descartados } = build(linha);
    await (
      service as unknown as {
        discardIfResidue: (i: typeof item, f: string) => Promise<void>;
      }
    ).discardIfResidue(item, 'file-nosso');
    return descartados;
  };

  it('CONCLUÍDA com o nosso arquivo: preserva — o commit venceu', async () => {
    /**
     * O caso que importa: se o COMMIT vence e só a resposta se perde, o catch
     * também roda. Apagar aqui levaria o MessageAttachment por cascade e
     * deixaria a mídia `fetched` sem arquivo, irreivindicável (o claim exige
     * `pending`) — o dano que a limpeza pretendia evitar, ao contrário.
     */
    expect(await descartar({ state: 'fetched', fileObjectId: 'file-nosso' })).toEqual([]);
  });

  it('ainda PENDENTE: descarta — a conclusão não venceu', async () => {
    expect(await descartar({ state: 'pending', fileObjectId: null })).toEqual(['file-nosso']);
  });

  it('concluída com OUTRO arquivo: descarta — outro coletor venceu', async () => {
    expect(await descartar({ state: 'fetched', fileObjectId: 'file-de-outro' })).toEqual([
      'file-nosso',
    ]);
  });

  it('linha ausente: descarta — não há nada que referencie o arquivo', async () => {
    expect(await descartar(null)).toEqual(['file-nosso']);
  });
});
