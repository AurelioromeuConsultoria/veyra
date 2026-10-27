import type {
  TemplateCategory,
  TemplateComponentDto,
  TemplateParameterFormat,
  TemplateReviewDto,
  TemplateVersionDto,
  TemplateVersionStatus,
} from '@veyra/contracts';

export interface LinhaDaRevisao {
  id: string;
  templateVersionId: string;
  purposeId: string;
  contentHash: string;
  reviewedByMembershipId: string;
  createdAt: Date;
}

export interface LinhaDaVersao {
  id: string;
  channelId: string;
  businessAccountId: string;
  metaTemplateId: string;
  name: string;
  language: string;
  version: number;
  category: TemplateCategory;
  parameterFormat: TemplateParameterFormat;
  components: unknown;
  bindings: unknown;
  contentHash: string;
  status: TemplateVersionStatus;
  createdAt: Date;
  reviews?: LinhaDaRevisao[];
}

export function revisaoDto(r: LinhaDaRevisao): TemplateReviewDto {
  return {
    id: r.id,
    templateVersionId: r.templateVersionId,
    purposeId: r.purposeId,
    contentHash: r.contentHash,
    reviewedByMembershipId: r.reviewedByMembershipId,
    createdAt: r.createdAt.toISOString(),
  };
}

export function versaoDto(v: LinhaDaVersao): TemplateVersionDto {
  return {
    id: v.id,
    channelId: v.channelId,
    businessAccountId: v.businessAccountId,
    metaTemplateId: v.metaTemplateId,
    name: v.name,
    language: v.language,
    version: v.version,
    category: v.category,
    parameterFormat: v.parameterFormat,
    components: v.components as TemplateComponentDto[],
    bindings: v.bindings as Record<string, string>,
    contentHash: v.contentHash,
    status: v.status,
    createdAt: v.createdAt.toISOString(),
    reviews: (v.reviews ?? []).map(revisaoDto),
  };
}
