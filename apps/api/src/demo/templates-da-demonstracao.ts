/**
 * O CADASTRO dos templates fictícios da demonstração (ADR-048 adendo 12, item
 * 2): o vínculo de cada parâmetro e a finalidade que revisa a versão. É dado
 * da demonstração, fora dos módulos do Core, e só o procedimento
 * `templates:demo` o lê; o conteúdo é o de `catalogo-da-demonstracao.ts`.
 */
export interface TemplateDaDemonstracao {
  /** o nome no catálogo fictício (o idioma é `pt_BR`) */
  nome: string;
  /** parâmetro → campo, como o `--param` da CLI de cadastro */
  vinculos: Record<string, string>;
  /** a chave da finalidade que revisa a versão (a versão mais recente dela) */
  finalidade: string;
}

export const TEMPLATES_DA_DEMONSTRACAO: readonly TemplateDaDemonstracao[] = [
  {
    nome: 'demo_confirmacao_horario',
    vinculos: {
      'body.1': 'contato.primeiro_nome',
      'body.2': 'clinics.data',
      'body.3': 'clinics.hora',
    },
    finalidade: 'clinics_confirmacao',
  },
  {
    nome: 'demo_reativacao_retorno',
    vinculos: { 'body.1': 'contato.primeiro_nome' },
    finalidade: 'clinics_reativacao',
  },
  {
    nome: 'demo_retomar_conversa',
    vinculos: { 'body.1': 'contato.nome' },
    finalidade: 'atendimento_retomada',
  },
];
