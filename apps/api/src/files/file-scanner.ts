/**
 * Porta do SCANNER de arquivos (ADR-043). Mesmo desenho de `LLM_CLIENT` e
 * `META_TRANSPORT`: a implementação real fica atrás do símbolo, e o teste
 * injeta um dublê — nenhuma suíte depende de ClamAV instalado.
 */
export const FILE_SCANNER = Symbol('FILE_SCANNER');

export type ScanVerdict =
  /** limpo pelo scanner */
  | { status: 'clean' }
  /** ameaça encontrada; `threat` é o NOME curto, nunca a saída bruta */
  | { status: 'infected'; threat: string }
  /** scanner indisponível ou erro: NÃO é veredito, o arquivo segue `pending` */
  | { status: 'unavailable'; reason: string };

export interface FileScanner {
  scan(bytes: Buffer): Promise<ScanVerdict>;
}
