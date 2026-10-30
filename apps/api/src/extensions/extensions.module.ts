import { type DynamicModule, Global, Module, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  CONTENT_RESTRICTION_PROVIDERS,
  ContentRestrictionService,
  type ContentRestrictionProvider,
} from './content-restriction';
import {
  EXPERIENCE_AVAILABILITY_PROVIDERS,
  ExperienceService,
  type ExperienceAvailabilityProvider,
} from './experience';
import type { CoreExtension } from './extension';
import {
  OUTBOUND_PRECONDITION_PROVIDERS,
  OutboundPreconditionService,
  type OutboundPreconditionProvider,
} from './outbound-precondition';
import { PermissionCatalogCheck } from './permission-catalog.check';
import { EXTENSION_REGISTRY, composeRegistry } from './registry';

export interface ExtensionsOptions {
  extensions: readonly CoreExtension[];
  /** implementações da porta do E6, com injeção de dependência normal */
  contentRestrictionProviders?: readonly Type<ContentRestrictionProvider>[];
  /**
   * implementações da porta do E7 (a pré-condição do envio do negócio, F4.1c-3),
   * uma por prefixo de origem
   */
  outboundPreconditionProviders?: readonly Type<OutboundPreconditionProvider>[];
  /**
   * a disponibilidade de cada experiência de extensão (ADR-055 adendo 1): uma
   * por experiência declarada, conferida no boot
   */
  experienceAvailabilityProviders?: readonly Type<ExperienceAvailabilityProvider>[];
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
    const precondicoes = [...(options.outboundPreconditionProviders ?? [])];
    const disponibilidades = [...(options.experienceAvailabilityProviders ?? [])];
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
        ...precondicoes,
        {
          provide: OUTBOUND_PRECONDITION_PROVIDERS,
          useFactory: (...instances: OutboundPreconditionProvider[]) => instances,
          inject: precondicoes,
        },
        OutboundPreconditionService,
        ...disponibilidades,
        {
          provide: EXPERIENCE_AVAILABILITY_PROVIDERS,
          useFactory: (...instances: ExperienceAvailabilityProvider[]) => instances,
          inject: disponibilidades,
        },
        ExperienceService,
        PermissionCatalogCheck,
      ],
      exports: [
        EXTENSION_REGISTRY,
        ContentRestrictionService,
        OutboundPreconditionService,
        ExperienceService,
      ],
    };
  }
}
