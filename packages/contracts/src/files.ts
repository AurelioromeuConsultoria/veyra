export type FileScanStatus = 'pending' | 'clean' | 'quarantined';

export interface FileObjectDto {
  id: string;
  fileName: string;
  /** MIME DETECTADO por magic bytes no servidor, nunca o declarado */
  mimeType: string;
  sizeBytes: number;
  scanStatus: FileScanStatus;
  uploadedByMembershipId: string;
  createdAt: string;
}
