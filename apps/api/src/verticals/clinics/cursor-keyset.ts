import { BadRequestException } from '@nestjs/common';

/**
 * O cursor keyset das listas do Clinics ordenadas do mais recente para o mais
 * antigo, por `(createdAt, id)`: opaco para quem chama, recusado com 400 se
 * não for um que a rota emitiu.
 */
export interface CursorKeyset {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: CursorKeyset): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString('base64url');
}

export function decodeCursor(raw: string): CursorKeyset {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso);
  // uma data fora da faixa viraria erro do banco (500), não "cursor inválido"
  const ano = createdAt.getUTCFullYear();
  if (Number.isNaN(createdAt.getTime()) || ano < 1970 || ano > 9999 || !UUID.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { createdAt, id };
}

/** O filtro "depois do cursor" na ordem `createdAt desc, id desc`. */
export function depoisDoCursor(cursor: CursorKeyset | null): object {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}
