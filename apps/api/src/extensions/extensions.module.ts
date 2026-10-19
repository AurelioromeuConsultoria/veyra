import { type DynamicModule, Global, Module, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  CONTENT_RESTRICTION_PROVIDERS,
  ContentRestrictionService,
  type ContentRestrictionProvider,
} from './content-restriction';
import type { CoreExtension } from './extension';
import { PermissionCatalogCheck } from './permission-catalog.check';
import { EXTENSION_REGISTRY, composeRegistry } from './registry';

export interface ExtensionsOptions {
  extensions: readonly CoreExtension[];
  /** implementações da porta do E6, com injeção de dependência normal */
  contentRestrictionProviders?: readonly Type<ContentRestrictionProvider>[];
}

/**
 * Ponto ÚNICO onde as extensões entram no Core (ADR-047). Chamado só pela raiz
 * de composição (`app.module.ts`, a partir de `composition.ts`). Global: o
 * PrismaService, a auditoria, a IA e os webhooks leem daqui sem importar nada
 * de vertical.
 */
@Global()
@Module({})
export class ExtensionsModule {
  static forRoot(options: ExtensionsOptions): DynamicModule {
    const registry = composeRegistry(options.extensions);
    const providerClasses = [...(options.contentRestrictionProviders ?? [])];
    return {
      module: ExtensionsModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: EXTENSION_REGISTRY, useValue: registry },
        ...providerClasses,
        {
          provide: CONTENT_RESTRICTION_PROVIDERS,
          useFactory: (...instances: ContentRestrictionProvider[]) => instances,
          inject: providerClasses,
        },
        ContentRestrictionService,
        PermissionCatalogCheck,
      ],
      exports: [EXTENSION_REGISTRY, ContentRestrictionService],
    };
  }
}
