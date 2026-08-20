/**
 * Sniffer de MAGIC BYTES para uma allowlist FECHADA (ADR-025).
 *
 * Por que não `file-type`: a lib é ESM pura desde a v17 e o runner de testes é
 * CJS — já pagamos esse preço com o pg-boss. Para sete tipos, a tabela abaixo é
 * determinística e testável. Gatilho para trocar: allowlist aberta.
 *
 * SVG está DELIBERADAMENTE fora: é XML executável, vetor de XSS no download.
 */
export interface DetectedType {
  mimeType: string;
  extensions: string[];
}

type Signature = { magic: number[]; offset?: number; type: DetectedType };

const SIGNATURES: Signature[] = [
  { magic: [0x89, 0x50, 0x4e, 0x47], type: { mimeType: 'image/png', extensions: ['png'] } },
  { magic: [0xff, 0xd8, 0xff], type: { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'] } },
  { magic: [0x47, 0x49, 0x46, 0x38], type: { mimeType: 'image/gif', extensions: ['gif'] } },
  { magic: [0x25, 0x50, 0x44, 0x46], type: { mimeType: 'application/pdf', extensions: ['pdf'] } },
];

/** WebP é RIFF….WEBP: precisa dos dois pedaços, senão qualquer RIFF passaria. */
function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

/** ZIP cobre .zip e os OOXML (.docx/.xlsx/.pptx), que são zip por dentro. */
const ZIP_MAGICS = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06], // vazio
  [0x50, 0x4b, 0x07, 0x08], // spanned
];

const OOXML_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);

function startsWith(buffer: Buffer, magic: number[], offset = 0): boolean {
  if (buffer.length < offset + magic.length) return false;
  return magic.every((byte, i) => buffer[offset + i] === byte);
}

/**
 * Texto não tem assinatura, então a regra é por exclusão: UTF-8 válido E sem
 * bytes de controle além de tab/CR/LF/FF. Só olhar NUL não basta — um binário
 * pequeno pode não ter NUL nenhum e ainda ser UTF-8 válido (o teste do ELF
 * pegou exatamente isso); bytes de controle no meio do conteúdo denunciam que
 * aquilo não é um documento de texto.
 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0c, 0x0d]);

function looksLikeText(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte < 0x20 && !ALLOWED_CONTROL.has(byte)) return false;
    if (byte === 0x7f) return false; // DEL
  }
  const decoded = new TextDecoder('utf-8', { fatal: true });
  try {
    decoded.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Devolve o tipo REAL do conteúdo, ou null se estiver fora da allowlist. */
export function detectType(buffer: Buffer, fileName: string): DetectedType | null {
  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.magic, signature.offset)) return signature.type;
  }
  if (isWebp(buffer)) return { mimeType: 'image/webp', extensions: ['webp'] };
  if (ZIP_MAGICS.some((magic) => startsWith(buffer, magic))) {
    const extension = extensionOf(fileName);
    // o container é o mesmo; a extensão declarada escolhe o rótulo, e só entre
    // as que aceitamos — nunca vira "qualquer coisa"
    if (extension === 'docx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extensions: ['docx'],
      };
    }
    if (extension === 'xlsx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extensions: ['xlsx'],
      };
    }
    if (extension === 'pptx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extensions: ['pptx'],
      };
    }
    return { mimeType: 'application/zip', extensions: ['zip', ...OOXML_EXTENSIONS] };
  }
  if (looksLikeText(buffer)) {
    const extension = extensionOf(fileName);
    if (extension === 'csv') return { mimeType: 'text/csv', extensions: ['csv'] };
    if (extension === 'txt' || extension === 'md') {
      return { mimeType: 'text/plain', extensions: ['txt', 'md'] };
    }
    return null; // texto com extensão de binário = divergência
  }
  return null;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export class UnsupportedFileError extends Error {}

/**
 * Valida conteúdo × extensão. `.png` com bytes de PDF é rejeitado — é
 * exatamente o caso que a política do §7.1 existe para pegar.
 */
export function assertAllowedFile(buffer: Buffer, fileName: string): DetectedType {
  const detected = detectType(buffer, fileName);
  if (!detected) {
    throw new UnsupportedFileError(
      'Tipo de arquivo não suportado — envie imagem (PNG/JPEG/GIF/WebP), PDF, documento Office, ZIP ou texto',
    );
  }
  const extension = extensionOf(fileName);
  if (!extension || !detected.extensions.includes(extension)) {
    throw new UnsupportedFileError(
      `A extensão .${extension || '(nenhuma)'} não corresponde ao conteúdo (${detected.mimeType})`,
    );
  }
  return detected;
}
