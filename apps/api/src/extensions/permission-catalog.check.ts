import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../common/decorators';
import { EXTENSION_REGISTRY, type ComposedRegistry } from './registry';

/**
 * Checagem de BOOT do E2 (ADR-047): toda chave exigida por alguma rota precisa
 * existir no catálogo composto. Cada lado tipa as próprias chaves em tempo de
 * compilação; a união das duas só existe aqui, então é aqui que ela é conferida.
 * Chave desconhecida derrubaria a rota em runtime (403 para todos) — melhor não
 * subir.
 */
@Injectable()
export class PermissionCatalogCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject(EXTENSION_REGISTRY) private readonly registry: ComposedRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const unknown = this.unknownKeys();
    if (unknown.length > 0) {
      throw new Error(
        `Rotas exigem permissões fora do catálogo composto: ${unknown.join(', ')} (ADR-047, E2).`,
      );
    }
  }

  unknownKeys(): string[] {
    const unknown = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const fromClass = this.reflector.get<string[] | undefined>(PERMISSIONS_KEY, metatype) ?? [];
      const prototype = Object.getPrototypeOf(instance) as object;
      const handlers = this.scanner.getAllMethodNames(prototype);
      for (const key of fromClass) {
        if (!this.registry.permissionKeys.has(key)) unknown.add(key);
      }
      for (const handler of handlers) {
        const method = (prototype as Record<string, unknown>)[handler];
        if (typeof method !== 'function') continue;
        const keys = this.reflector.get<string[] | undefined>(PERMISSIONS_KEY, method) ?? [];
        for (const key of keys) {
          if (!this.registry.permissionKeys.has(key)) unknown.add(key);
        }
      }
    }
    return [...unknown].sort();
  }
}
