import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'node:net';
import type { FileScanner, ScanVerdict } from './file-scanner';

/** Teto do INSTREAM do clamd; acima disso ele encerra a conexão. */
const CHUNK = 64 * 1024;
const TIMEOUT_MS = 15_000;
/**
 * Teto do que aceitamos ler. Qualquer resposta do clamd cabe em bytes; sem
 * limite, um host que apenas FALE (endpoint de stream, tail de log) enche a heap
 * do processo — e o `setTimeout` do socket é OCIOSO, então um byte por segundo
 * nunca o dispara. Por isso há também um prazo absoluto.
 */
const MAX_RESPOSTA = 4096;

/**
 * ClamAV pelo protocolo INSTREAM do `clamd` (ADR-043): manda os bytes por TCP e
 * lê o veredito, sem escrever arquivo temporário e sem shell.
 *
 * Sem host configurado, devolve `unavailable` — e `unavailable` NÃO é veredito:
 * o arquivo continua `pending`, que já não sai para canal externo. A ausência de
 * scanner degrada para o comportamento seguro, nunca para "liberado".
 */
/**
 * Traduz a resposta do clamd em veredito. FAIL-CLOSED e nesta ordem:
 *
 * 1. `FOUND` primeiro. Testar "OK" antes fazia
 *    `Sanesecurity.Foxhole.OK.UNOFFICIAL FOUND` virar LIMPO — nomes de
 *    assinatura vêm de terceiros e podem conter qualquer coisa.
 * 2. Limpo SÓ na forma canônica `stream: OK`. A versão anterior aceitava
 *    qualquer texto contendo "OK", então um `HTTP/1.1 200 OK` — host apontado
 *    para o serviço errado — marcava TODO arquivo como limpo, em silêncio.
 * 3. Qualquer outra coisa é `unavailable`, que não é veredito: o arquivo fica
 *    `pending` e não sai para canal externo.
 *
 * Função pura para poder ser testada com as formas reais do protocolo, que é o
 * que faltava: era a única lógica que decide "é malware?" sem cobertura.
 */
export function parseVerdict(resposta: string): ScanVerdict {
  const limpa = resposta.replace(/\0/g, '').trim();
  const encontrado = /^stream:\s*(.+?)\s+FOUND$/.exec(limpa);
  if (encontrado) return { status: 'infected', threat: encontrado[1].slice(0, 120) };
  if (/^stream:\s*OK$/.test(limpa)) return { status: 'clean' };
  return { status: 'unavailable', reason: 'unexpected_response' };
}

@Injectable()
export class ClamavScanner implements FileScanner {
  private readonly logger = new Logger(ClamavScanner.name);
  private readonly host?: string;
  private readonly port: number;

  constructor(config: ConfigService) {
    this.host = config.get<string>('CLAMAV_HOST');
    this.port = config.get<number>('CLAMAV_PORT') ?? 3310;
    if (!this.host) {
      // UMA vez, no boot: sem isto, "nenhum arquivo está sendo verificado nesta
      // instalação" só apareceria como um `warn` por arquivo, indistinguível de
      // ruído — e um deploy que esqueça a variável não escaneia nada em silêncio
      this.logger.warn(
        'CLAMAV_HOST ausente: NENHUM arquivo será verificado. Todos ficam `pending`, ' +
          'e `pending` não sai para canal externo (ADR-043).',
      );
    }
  }

  async scan(bytes: Buffer): Promise<ScanVerdict> {
    if (!this.host) return { status: 'unavailable', reason: 'no_scanner' };
    try {
      /**
       * IDENTIDADE ANTES DO VEREDITO. Sem isto, `CLAMAV_HOST` apontando para
       * qualquer serviço que responda algo com "OK" — um ingress, um health
       * endpoint, um port-forward trocado — faria TODO arquivo virar `clean` em
       * silêncio, e o sintoma seria "o scanner está funcionando lindamente".
       */
      if (!(await this.isClamd())) return { status: 'unavailable', reason: 'not_clamd' };
      return parseVerdict(await this.instream(bytes));
    } catch (error) {
      // motivo CURTO: nunca a saída bruta do scanner nem stack trace
      const reason = error instanceof Error ? error.name : 'scanner_error';
      this.logger.warn(`ClamAV indisponível (${reason})`);
      return { status: 'unavailable', reason };
    }
  }

  /** `zPING` → `PONG`: confirma que quem atende na porta é mesmo um clamd. */
  private async isClamd(): Promise<boolean> {
    const resposta = await this.conversar((socket) => socket.write('zPING\0'));
    return /^PONG\0?$/.test(resposta.trim());
  }

  private instream(bytes: Buffer): Promise<string> {
    return this.conversar((socket) => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const pedaco = bytes.subarray(i, i + CHUNK);
        const tamanho = Buffer.alloc(4);
        tamanho.writeUInt32BE(pedaco.length);
        socket.write(tamanho);
        socket.write(pedaco);
      }
      // tamanho zero encerra o fluxo e pede o veredito
      socket.write(Buffer.alloc(4));
    });
  }

  /** Abre a conexão, escreve o que `escrever` mandar e devolve a resposta. */
  private conversar(escrever: (socket: Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let saida = '';
      // prazo ABSOLUTO: o do socket só conta ociosidade
      const prazo = setTimeout(() => encerrar(new Error('ScannerDeadline')), TIMEOUT_MS * 2);
      const encerrar = (erro?: Error) => {
        clearTimeout(prazo);
        socket.destroy();
        if (erro) reject(erro);
        else resolve(saida);
      };
      socket.setTimeout(TIMEOUT_MS, () => encerrar(new Error('ScannerTimeout')));
      socket.on('data', (chunk) => {
        saida += chunk.toString('utf8');
        if (saida.length > MAX_RESPOSTA) encerrar(new Error('ScannerRespostaGrande'));
      });
      socket.on('error', encerrar);
      socket.on('end', () => encerrar());
      socket.connect(this.port, this.host as string, () => escrever(socket));
    });
  }
}
