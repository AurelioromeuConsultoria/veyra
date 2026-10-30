/**
 * Contrato de extensão do Core (ADR-047). Um vertical se descreve com UM objeto
 * deste tipo, entregue na raiz de composição (`src/composition.ts`). Não há
 * descoberta, manifesto nem gancho de ciclo de vida: o Core só recebe listas
 * fechadas e as valida no boot (`registry.ts`).
 *
 * Nada aqui nomeia um vertical. O Core sabe que extensões existem, nunca quais.
 */
export interface TenantModelsContribution {
  /** modelos novos com `workspaceId` — entram no client protegido (E1) */
  readonly workspaceModels: readonly string[];
  /** subconjunto dos modelos acima que é append-only */
  readonly appendOnlyModels?: readonly string[];
  /**
   * relações dos modelos da extensão E as que ela acrescenta a modelos já
   * existentes (o lado oposto que o Prisma exige numa relação). Acréscimo a
   * modelo alheio só pode apontar para modelo da própria extensão.
   */
  readonly relationTargets: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface CoreExtension {
  /**
   * Nome curto e estável. É o PREFIXO obrigatório das chaves de permissão
   * (`<name>:...`) e dos tipos de entidade de auditoria (`<name>...`).
   */
  readonly name: string;
  readonly tenantModels?: TenantModelsContribution;
  /** catálogo de permissões da extensão (E2), descrição por chave */
  readonly permissionCatalog?: Readonly<Record<string, string>>;
  /** allowlist de auditoria por tipo de entidade (E4) */
  readonly auditFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * A experiência de produto da extensão (ADR-055; adendo ao E5), no máximo
   * uma, com a chave igual ao `name`. `selectable`: a operação pode pô-la num
   * workspace — falso enquanto o frontend dela não existe. A disponibilidade
   * por workspace vem de um `ExperienceAvailabilityProvider` da composição.
   */
  readonly experience?: { readonly selectable: boolean };
}
