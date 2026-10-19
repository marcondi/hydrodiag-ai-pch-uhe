export type DiagramCategoryTag = '/EL' | '/RB' | '/ME' | '/RM' | 'FOTO CAMPO';

export type InvestigationStatus =
  | 'em_investigacao'
  | 'resolvida'
  | 'aguardando_peca';

export interface DiagramAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  base64Data: string;
  previewUrl?: string;
  sequenceIndex: number;
  categoryTag: DiagramCategoryTag;
  panelName?: string;
  addedAtTimestamp: string;
  serverUploadStatus?: 'uploading' | 'synced' | 'error';
  uploadProgress?: number;
}

export interface ChatAttachmentPayload {
  base64: string;
  mimeType: string;
  name: string;
  sizeBytes?: number;
  categoryTag?: DiagramCategoryTag;
  panelName?: string;
}

export interface FaultChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  inspectedPages?: number[];
  attachedImageName?: string;
  attachedFileCategory?: DiagramCategoryTag;
  attachedPanelName?: string;
}

export interface DiagnosticTurn {
  id: string;
  timestamp: string;
  userQuery: string;
  focusTopic?: string;
  attachedFileNames: string[];
  sequenceCountAtTurn: number;
  markdownResponse: string;
  requiresNextDrawing: boolean;
  chatMessages?: FaultChatMessage[];
}

export interface SafetyChecklistItem {
  id: string;
  code: string;
  label: string;
  detail: string;
  checked: boolean;
}

export interface SavedInvestigationSummary {
  id: string;
  title: string;
  panelTag?: string;
  status: InvestigationStatus;
  isFavorite?: boolean;
  fieldResolutionNote?: string;
  createdAt: string;
  updatedAt: string;
  attachmentMetadata: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    sequenceIndex: number;
    categoryTag: DiagramCategoryTag;
    panelName?: string;
  }>;
  turns: DiagnosticTurn[];
}
