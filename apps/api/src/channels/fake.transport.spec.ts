import { FakeMetaTransport } from './fake.transport';

const credencial = { phoneNumberId: '1', token: 't' };

/**
 * O transporte falso é código de produto que FINGE um efeito externo. O que
 * este spec protege não é o caminho feliz — é que ele continue inconfundível:
 * id sintético marcado, e mídia recusada em vez de inventada.
 */
describe('FakeMetaTransport', () => {
  it('devolve id SINTÉTICO e marcado, impossível de confundir com um wamid real', async () => {
    const transporte = new FakeMetaTransport();
    const texto = await transporte.sendText(credencial, '+5511999998888', 'oi');
    const template = await transporte.sendTemplate(
      credencial,
      '+5511999998888',
      { name: 'retorno', language: 'pt_BR' },
      { header: [], body: [{ text: '10h' }] },
    );

    expect(texto.ok).toBe(true);
    expect(template.ok).toBe(true);
    // `wamid.FAKE-` salta aos olhos em log, banco e tela
    if (texto.ok) expect(texto.externalId).toMatch(/^wamid\.FAKE-/);
    if (template.ok) expect(template.externalId).toMatch(/^wamid\.FAKE-/);
    // ids distintos: reaproveitar um só mascararia deduplicação quebrada
    if (texto.ok && template.ok) expect(texto.externalId).not.toBe(template.externalId);
  });

  it('RECUSA coleta de mídia em vez de devolver bytes inventados', async () => {
    /**
     * Bytes sintéticos passariam pelo scanner e virariam anexo real no banco —
     * um arquivo que ninguém enviou. Falhar deixa a `InboundMedia` em erro,
     * que é um estado honesto e visível.
     */
    const resultado = await new FakeMetaTransport().fetchMedia(credencial, 'media-1');
    expect(resultado.ok).toBe(false);
  });
});
