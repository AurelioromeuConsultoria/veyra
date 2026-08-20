import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Interface estreita (ADR-024): trocar disco por S3/MinIO é um driver novo,
 * sem tocar em service. A CHAVE é sempre derivada no servidor.
 */
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

export interface StorageDriver {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class UnsafeKeyError extends Error {}

/**
 * A chave nasce no servidor (`{workspaceId}/{uuid}{ext}`), mas validá-la aqui
 * também é barato — e é a última linha de defesa se algum caminho futuro deixar
 * input do cliente chegar até ela. Travessia, caminho absoluto e separador do
 * SO fora do formato esperado são recusados.
 */
export function assertSafeKey(key: string): void {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/i.test(key)) {
    throw new UnsafeKeyError('Chave de storage inválida');
  }
}

@Injectable()
export class LocalDiskDriver implements StorageDriver {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('STORAGE_ROOT') ?? '.storage');
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = normalize(join(this.root, key));
    // cinto e suspensório: mesmo com a chave validada, nada escapa da raiz
    if (!full.startsWith(this.root + sep)) {
      throw new UnsafeKeyError('Chave de storage escapa da raiz');
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
