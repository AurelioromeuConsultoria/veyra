import { UnsupportedFileError, assertAllowedFile, detectType } from './file-type';

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const pdf = () => Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'binary');
const webp = () => {
  const buffer = Buffer.alloc(16);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  return buffer;
};
const zip = () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

describe('detecção de tipo por magic bytes (ADR-025)', () => {
  it('reconhece os tipos da allowlist', () => {
    expect(detectType(png(), 'foto.png')?.mimeType).toBe('image/png');
    expect(detectType(pdf(), 'contrato.pdf')?.mimeType).toBe('application/pdf');
    expect(detectType(webp(), 'banner.webp')?.mimeType).toBe('image/webp');
    expect(detectType(Buffer.from('nome;valor\na;1\n'), 'dados.csv')?.mimeType).toBe('text/csv');
  });

  it('OOXML é ZIP por dentro: a extensão declarada escolhe o rótulo, dentro da allowlist', () => {
    expect(detectType(zip(), 'proposta.docx')?.mimeType).toContain('wordprocessingml');
    expect(detectType(zip(), 'planilha.xlsx')?.mimeType).toContain('spreadsheetml');
    expect(detectType(zip(), 'pacote.zip')?.mimeType).toBe('application/zip');
  });

  it('RIFF que NÃO é WebP não passa (assinatura exige os dois pedaços)', () => {
    const riff = Buffer.alloc(16);
    riff.write('RIFF', 0, 'ascii');
    riff.write('AVI ', 8, 'ascii');
    expect(detectType(riff, 'video.webp')).toBeNull();
  });

  it('SVG está fora da allowlist (XSS no download)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(() => assertAllowedFile(svg, 'logo.svg')).toThrow(UnsupportedFileError);
  });

  it('binário disfarçado de texto é recusado (byte NUL)', () => {
    const disfarcado = Buffer.from([0x41, 0x00, 0x42]);
    expect(detectType(disfarcado, 'notas.txt')).toBeNull();
  });

  it('P0 da política §7.1: extensão que diverge do conteúdo é rejeitada', () => {
    // PNG renomeado para .pdf
    expect(() => assertAllowedFile(png(), 'malicioso.pdf')).toThrow(/não corresponde ao conteúdo/i);
    // PDF renomeado para .png
    expect(() => assertAllowedFile(pdf(), 'malicioso.png')).toThrow(/não corresponde ao conteúdo/i);
    // e o par coerente passa
    expect(assertAllowedFile(png(), 'foto.png').mimeType).toBe('image/png');
  });

  it('arquivo sem extensão é rejeitado', () => {
    expect(() => assertAllowedFile(png(), 'semextensao')).toThrow(UnsupportedFileError);
  });

  it('executável não entra de jeito nenhum, nem renomeado para .txt', () => {
    // ELF real não tem NUL nos primeiros bytes e é UTF-8 válido: só a regra de
    // bytes de CONTROLE o barra como "texto"
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    expect(detectType(elf, 'payload.png')).toBeNull();
    expect(detectType(elf, 'payload.txt')).toBeNull();
  });

  it('texto de verdade (com acento, tab e quebra de linha) continua passando', () => {
    const texto = Buffer.from('Relatório\tmensal\nlinha 2\r\nçãé\n', 'utf8');
    expect(detectType(texto, 'notas.txt')?.mimeType).toBe('text/plain');
  });
});
