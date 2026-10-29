import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Camera,
  CheckCircle2,
  Eye,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Laptop,
  Loader2,
  Mic,
  MicOff,
  Send,
  Share2,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  ChatAttachmentPayload,
  DiagramAttachment,
  DiagnosticTurn,
  InvestigationStatus,
  SavedInvestigationSummary,
} from '../types';
import {
  extractInteractiveMeasurementsFromMarkdown,
  extractProbeSummaryFromMarkdown,
  getCachedPdfIndex,
  loadAttachmentBinaryFromVault,
  PageBatchIndex,
  resolveCitationToPdfPage,
} from '../utils/pdfClientEngine';
import { UniversalVoiceDictation } from '../utils/voiceDictationEngine';
import { technicalSpeechEngine } from '../utils/speechSynthesisEngine';
import {
  PdfDeepLinkDrawer,
  pickBestAttachmentForPage,
} from './PdfDeepLinkDrawer';

interface MobileFieldPocketViewProps {
  attachments: DiagramAttachment[];
  turns: DiagnosticTurn[];
  query: string;
  setQuery: (val: string) => void;
  isUploading: boolean;
  isAnalyzing: boolean;
  progressStep: string;
  isChatSending: boolean;
  chatProgressStep: string;
  error: string | null;
  savedInvestigations: SavedInvestigationSummary[];
  sessionId: string;
  investigationStatus: InvestigationStatus;
  onUpdateStatus: (status: InvestigationStatus) => void;
  fieldContrastMode: boolean;
  onToggleFieldContrast: () => void;
  isSyncingCloud: boolean;
  onSyncCloud: () => void;
  onLoadInvestigation: (saved: SavedInvestigationSummary) => void;
  onNewInvestigation: () => void;
  onAddFiles: (files: FileList) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onRunDiagnosis: (customQuery?: string) => Promise<void>;
  onCancelDiagnosis?: () => void;
  onOpenFieldCamera: () => void;
  onOpenPdfPage: (pageNumber: number, attachmentId?: string) => void;
  onRelinkAttachmentBinary?: (
    attachmentId: string,
    base64Data: string,
    fileName?: string,
    sizeBytes?: number
  ) => void;
  onSendChatMessage: (
    turnId: string,
    messageText: string,
    attachment?: ChatAttachmentPayload
  ) => Promise<void>;
  onExitMobileMode: () => void;
}

/**
 * Classificação estrita de mídia para garantir que fotos da galeria/câmera
 * NUNCA sejam tratadas como documentos PDF pelo Inspetor de Folhas PDF.
 */
export function isStrictlyPhotoAttachment(att: DiagramAttachment): boolean {
  const lowerName = (att.name || '').trim().toLowerCase();
  const lowerMime = (att.mimeType || '').trim().toLowerCase();
  if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf') {
    return false;
  }
  if (
    lowerMime.startsWith('image/') ||
    /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif)$/i.test(lowerName) ||
    att.categoryTag === 'FOTO CAMPO'
  ) {
    return true;
  }
  return false;
}

export function isStrictlyPdfAttachment(att: DiagramAttachment): boolean {
  return !isStrictlyPhotoAttachment(att);
}

export interface CitedSheetReference {
  pdfPage: number;
  folhaSelo?: number;
}

export function extractCitedPagesFromMarkdown(
  markdown: string,
  cachedBatches?: PageBatchIndex[] | null
): CitedSheetReference[] {
  const byPdfPage = new Map<number, CitedSheetReference>();
  const regex =
    /\b(P[áa]g(?:ina)?s?\.?|Folha(?:\s+do\s+Selo|\s+Selo)?(?:\s+FL\.?)?|Fl(?:s)?\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,4})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const label = match[1].trim();
    const num = parseInt(match[2], 10);
    if (!isNaN(num) && num >= 1 && num <= 2000) {
      const isFolha = /^(?:Folha|Fl)/i.test(label);
      const resolved = resolveCitationToPdfPage(
        num,
        isFolha,
        markdown,
        cachedBatches
      );
      const existing = byPdfPage.get(resolved.pdfPage);
      if (!existing) {
        byPdfPage.set(resolved.pdfPage, {
          pdfPage: resolved.pdfPage,
          folhaSelo: resolved.folhaSelo,
        });
      } else if (existing.folhaSelo === undefined && resolved.folhaSelo !== undefined) {
        existing.folhaSelo = resolved.folhaSelo;
      }
    }
  }
  return Array.from(byPdfPage.values()).sort((a, b) => a.pdfPage - b.pdfPage);
}

export const MobileFieldPocketView: React.FC<MobileFieldPocketViewProps> = ({
  attachments,
  turns,
  query,
  setQuery,
  isUploading,
  isAnalyzing,
  progressStep,
  isChatSending,
  chatProgressStep,
  error,
  savedInvestigations,
  sessionId,
  investigationStatus,
  onUpdateStatus,
  fieldContrastMode,
  onToggleFieldContrast,
  onLoadInvestigation,
  onNewInvestigation,
  onAddFiles,
  onRemoveAttachment,
  onRunDiagnosis,
  onCancelDiagnosis,
  onRelinkAttachmentBinary,
  onSendChatMessage,
  onExitMobileMode,
}) => {
  const [screen, setScreen] = useState<'input' | 'result'>('input');
  const [showSavedList, setShowSavedList] = useState<boolean>(false);
  const [showFullLaudo, setShowFullLaudo] = useState<boolean>(false);
  const [manualPageInput, setManualPageInput] = useState<string>('1');
  const [manualInputMode, setManualInputMode] = useState<'page' | 'folha'>(
    'page'
  );
  const [chatInput, setChatInput] = useState<string>('');
  const [isDictatingQuery, setIsDictatingQuery] = useState<boolean>(false);
  const [isDictatingChat, setIsDictatingChat] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [mobileNotice, setMobileNotice] = useState<string | null>(null);

  // Separar fotos da galeria/câmera dos documentos PDF da sessão atual
  const photoAttachments = useMemo(
    () => attachments.filter((a) => isStrictlyPhotoAttachment(a)),
    [attachments]
  );

  const sessionPdfAttachments = useMemo(
    () => attachments.filter((a) => isStrictlyPdfAttachment(a)),
    [attachments]
  );

  // Catálogo de PDFs já salvos na Nuvem/Histórico (caso o usuário no celular tenha subido apenas uma foto da galeria e queira abrir uma página do PDF da usina)
  const [hydratedCloudPdfs, setHydratedCloudPdfs] = useState<
    Record<string, string>
  >({});

  const fallbackHistoryPdfAttachments = useMemo(() => {
    const map = new Map<string, DiagramAttachment>();
    for (const inv of savedInvestigations) {
      for (const meta of inv.attachmentMetadata || []) {
        const lowerName = (meta.name || '').trim().toLowerCase();
        const isPdf =
          meta.mimeType === 'application/pdf' || lowerName.endsWith('.pdf');
        if (!isPdf) continue;
        const key = lowerName || meta.id;
        if (!map.has(key)) {
          map.set(key, {
            id: meta.id,
            name: meta.name,
            mimeType: 'application/pdf',
            sizeBytes: meta.sizeBytes || 0,
            base64Data:
              hydratedCloudPdfs[meta.id] || hydratedCloudPdfs[lowerName] || '',
            sequenceIndex: meta.sequenceIndex || map.size + 1,
            categoryTag: meta.categoryTag || '/EL',
            panelName: meta.panelName,
            addedAtTimestamp: inv.updatedAt || inv.createdAt,
            serverUploadStatus: 'synced',
            uploadProgress: 100,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [savedInvestigations, hydratedCloudPdfs]);

  // Lista unificada APENAS de arquivos PDF (da sessão atual + histórico da usina), NUNCA incluindo fotos da galeria
  const allAvailablePdfAttachments = useMemo(() => {
    const combined: DiagramAttachment[] = [];
    const seenNames = new Set<string>();

    for (const pdf of sessionPdfAttachments) {
      const norm = pdf.name.trim().toLowerCase();
      seenNames.add(norm);
      combined.push({
        ...pdf,
        base64Data:
          pdf.base64Data ||
          hydratedCloudPdfs[pdf.id] ||
          hydratedCloudPdfs[norm] ||
          '',
      });
    }

    for (const histPdf of fallbackHistoryPdfAttachments) {
      const norm = histPdf.name.trim().toLowerCase();
      if (!seenNames.has(norm)) {
        seenNames.add(norm);
        combined.push(histPdf);
      }
    }

    return combined;
  }, [sessionPdfAttachments, fallbackHistoryPdfAttachments, hydratedCloudPdfs]);

  // Seletor de qual PDF está ativo para abrir páginas no celular
  const [selectedMobilePdfId, setSelectedMobilePdfId] = useState<string>('');

  useEffect(() => {
    if (allAvailablePdfAttachments.length === 0) {
      if (selectedMobilePdfId !== '') setSelectedMobilePdfId('');
      return;
    }
    const exists = allAvailablePdfAttachments.some(
      (p) => p.id === selectedMobilePdfId
    );
    if (!exists) {
      setSelectedMobilePdfId(allAvailablePdfAttachments[0].id);
    }
  }, [allAvailablePdfAttachments, selectedMobilePdfId]);

  // Hidratar automaticamente o binário dos PDFs em segundo plano para que abrir página nunca falhe
  useEffect(() => {
    let cancelled = false;
    const hydrateMissingPdfs = async () => {
      for (const pdf of allAvailablePdfAttachments) {
        if (cancelled) return;
        const norm = pdf.name.trim().toLowerCase();
        if (pdf.base64Data || hydratedCloudPdfs[pdf.id] || hydratedCloudPdfs[norm]) {
          continue;
        }
        try {
          const b64 = await loadAttachmentBinaryFromVault(pdf);
          if (b64 && !cancelled) {
            setHydratedCloudPdfs((prev) => ({
              ...prev,
              [pdf.id]: b64,
              [norm]: b64,
            }));
            if (
              onRelinkAttachmentBinary &&
              sessionPdfAttachments.some((s) => s.id === pdf.id)
            ) {
              onRelinkAttachmentBinary(pdf.id, b64, pdf.name, pdf.sizeBytes);
            }
          }
        } catch {
          // Ignore background hydration errors
        }
      }
    };
    hydrateMissingPdfs();
    return () => {
      cancelled = true;
    };
  }, [allAvailablePdfAttachments.length, sessionId]);

  // Estado exclusivo do Inspetor de Folha PDF (só recebe PDFs)
  const [mobilePdfOpen, setMobilePdfOpen] = useState<boolean>(false);
  const [mobilePdfPage, setMobilePdfPage] = useState<number>(1);
  const [mobilePdfAttachmentId, setMobilePdfAttachmentId] = useState<
    string | undefined
  >(undefined);

  // Estado exclusivo para visualizar Foto da Galeria / Câmera (nunca mistura com PDF)
  const [previewPhotoItem, setPreviewPhotoItem] =
    useState<DiagramAttachment | null>(null);

  const directCameraInputRef = useRef<HTMLInputElement | null>(null);
  const photoGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null);
  const chatPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const voiceEngineRef = useRef<UniversalVoiceDictation | null>(null);
  const queryRef = useRef<string>(query);
  queryRef.current = query;
  const chatInputRef = useRef<string>(chatInput);
  chatInputRef.current = chatInput;

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const prevTurnsCountRef = useRef<number>(turns.length);
  const userRequestedDiagnosisRef = useRef<boolean>(false);

  // Transicionar para a tela de resultado EXCLUSIVAMENTE quando o usuário clicou no botão "3. VER DIAGNÓSTICO E BORNES AGORA"
  useEffect(() => {
    if (turns.length > prevTurnsCountRef.current && turns.length > 0) {
      if (userRequestedDiagnosisRef.current) {
        userRequestedDiagnosisRef.current = false;
        setScreen('result');
      }
    }
    prevTurnsCountRef.current = turns.length;
  }, [turns.length]);

  const handleCancelMobileDiagnosis = () => {
    userRequestedDiagnosisRef.current = false;
    onCancelDiagnosis?.();
    setMobileNotice(
      'Diagnóstico cancelado. Você pode alterar a descrição, trocar a foto ou iniciar novamente quando quiser.'
    );
    setTimeout(() => setMobileNotice(null), 4500);
  };

  useEffect(() => {
    const unsub = technicalSpeechEngine.subscribe((st) => {
      setIsSpeaking(st.isSpeaking);
    });
    return () => {
      unsub();
      voiceEngineRef.current?.destroy();
      technicalSpeechEngine.stop();
    };
  }, []);

  const stopVoice = () => {
    if (voiceEngineRef.current) {
      voiceEngineRef.current.destroy();
      voiceEngineRef.current = null;
    }
    setIsDictatingQuery(false);
    setIsDictatingChat(false);
    setVoiceStatus(null);
  };

  const toggleVoiceForQuery = async () => {
    if (isDictatingQuery) {
      await voiceEngineRef.current?.stop();
      stopVoice();
      return;
    }
    stopVoice();
    const engine = new UniversalVoiceDictation({
      getInitialText: () => queryRef.current,
      onTextUpdate: (fullText) => {
        queryRef.current = fullText;
        setQuery(fullText);
      },
      onStateChange: (st) => {
        setIsDictatingQuery(st.isRecording || st.isTranscribing);
        setVoiceStatus(st.statusMessage);
      },
    });
    voiceEngineRef.current = engine;
    await engine.start();
  };

  const toggleVoiceForChat = async () => {
    if (isDictatingChat) {
      await voiceEngineRef.current?.stop();
      stopVoice();
      return;
    }
    stopVoice();
    const engine = new UniversalVoiceDictation({
      getInitialText: () => chatInputRef.current,
      onTextUpdate: (fullText) => {
        chatInputRef.current = fullText;
        setChatInput(fullText);
      },
      onStateChange: (st) => {
        setIsDictatingChat(st.isRecording || st.isTranscribing);
        setVoiceStatus(st.statusMessage);
      },
    });
    voiceEngineRef.current = engine;
    await engine.start();
  };

  /**
   * Resolutor determinístico de PDF para uma página solicitada:
   * Garante que NUNCA seleciona uma imagem da galeria, prioriza o PDF citado
   * no diagnóstico (ex: PSE+CLP-SASE vs PCPG2) e evita páginas reserva.
   */
  const resolveTargetPdfForPage = (
    pageNumber: number,
    explicitPdfId?: string
  ): DiagramAttachment | null => {
    if (allAvailablePdfAttachments.length === 0) return null;

    if (explicitPdfId) {
      const matched = allAvailablePdfAttachments.find(
        (p) => p.id === explicitPdfId
      );
      if (matched) return matched;
    }

    const bestFromDiagnosis = pickBestAttachmentForPage(
      allAvailablePdfAttachments,
      pageNumber,
      undefined,
      latestTurn?.markdownResponse
    );
    if (bestFromDiagnosis) {
      return bestFromDiagnosis;
    }

    if (selectedMobilePdfId) {
      const selectedPdf = allAvailablePdfAttachments.find(
        (p) => p.id === selectedMobilePdfId
      );
      if (selectedPdf) return selectedPdf;
    }

    return allAvailablePdfAttachments[0];
  };

  /**
   * Abre SEMPRE uma página de PDF no Inspetor de Diagrama Elétrico (nunca abre foto da galeria).
   */
  const handleOpenMobilePdfSheet = (
    pageNumber: number,
    explicitPdfId?: string
  ) => {
    const safePage = Math.max(1, Math.floor(pageNumber || 1));
    const targetPdf = resolveTargetPdfForPage(safePage, explicitPdfId);

    if (!targetPdf) {
      setMobileNotice(
        'Nenhum caderno PDF elétrico foi anexado ainda (apenas foto). Toque em "Anexar Diagrama Elétrico em PDF" para abrir as páginas do esquema.'
      );
      setTimeout(() => setMobileNotice(null), 6000);
      pdfFileInputRef.current?.click();
      return;
    }

    setMobileNotice(null);
    setSelectedMobilePdfId(targetPdf.id);
    setMobilePdfAttachmentId(targetPdf.id);
    setMobilePdfPage(safePage);
    setMobilePdfOpen(true);
  };

  const handleToggleSpeech = () => {
    if (!latestTurn) return;
    technicalSpeechEngine.toggleSpeak(
      latestTurn.id,
      latestTurn.markdownResponse
    );
  };

  const combinedMobileCachedBatches = useMemo(
    () =>
      allAvailablePdfAttachments.flatMap((pdf) => getCachedPdfIndex(pdf) || []),
    [allAvailablePdfAttachments]
  );

  const probeSummary = latestTurn
    ? extractProbeSummaryFromMarkdown(latestTurn.markdownResponse)
    : null;

  const measurementPoints = latestTurn
    ? extractInteractiveMeasurementsFromMarkdown(
        latestTurn.markdownResponse,
        probeSummary
      )
    : [];

  const citedPages = latestTurn
    ? extractCitedPagesFromMarkdown(
        latestTurn.markdownResponse,
        combinedMobileCachedBatches
      )
    : [];

  const handleSendMobileChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = chatInput.trim();
    if (!text || !latestTurn || isChatSending) return;
    stopVoice();
    setChatInput('');
    await onSendChatMessage(latestTurn.id, text);
  };

  /**
   * Transforma citações "Página X", "Pág. X", "Folha X", "FL. X" dentro de qualquer texto
   * em botões clicáveis que abrem diretamente a página FÍSICA correta do PDF
   * (convertendo automaticamente Folha do Selo WEG -> Página do PDF).
   */
  const renderTextWithClickablePdfPages = (rawText: string) => {
    if (!rawText) return null;
    const contextMd = latestTurn?.markdownResponse
      ? `${latestTurn.markdownResponse}\n${rawText}`
      : rawText;
    const parts = rawText.split(
      /(\b(?:P[áa]g(?:ina)?s?\.?|Folha(?:\s+do\s+Selo|\s+Selo)?(?:\s+FL\.?)?|Fl(?:s)?\.?)\s*(?:do\s+PDF\s*)?#?\s*\d{1,4}\b)/gi
    );
    return parts.map((segment, index) => {
      const m = segment.match(
        /^(P[áa]g(?:ina)?s?\.?|Folha(?:\s+do\s+Selo|\s+Selo)?(?:\s+FL\.?)?|Fl(?:s)?\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,4})$/i
      );
      if (m) {
        const label = m[1].trim();
        const citedNum = parseInt(m[2], 10);
        if (!isNaN(citedNum) && citedNum >= 1 && citedNum <= 2000) {
          const isFolha = /^(?:Folha|Fl)/i.test(label);
          const resolved = resolveCitationToPdfPage(
            citedNum,
            isFolha,
            contextMd,
            combinedMobileCachedBatches
          );
          const showConvertedHint =
            isFolha && resolved.pdfPage !== citedNum;
          return (
            <button
              key={`pg_link_${index}_${resolved.pdfPage}`}
              type="button"
              onClick={() => handleOpenMobilePdfSheet(resolved.pdfPage)}
              className="inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-md bg-sky-500/25 hover:bg-sky-500/40 border border-sky-400/50 text-sky-200 font-mono font-bold text-xs cursor-pointer"
              title={`Abrir Página ${resolved.pdfPage} do PDF${resolved.folhaSelo ? ` (Folha Selo FL. ${resolved.folhaSelo})` : ''}`}
            >
              <BookOpen className="w-3 h-3 text-sky-300 shrink-0" />
              <span>
                {segment}
                {showConvertedHint ? ` (Pág. ${resolved.pdfPage})` : ''}
              </span>
            </button>
          );
        }
      }
      return <React.Fragment key={`txt_${index}`}>{segment}</React.Fragment>;
    });
  };

  return (
    <div className="min-h-screen bg-[#070B14] text-slate-100 flex flex-col">
      {/* Inputs Nativos Ocultos */}
      <input
        ref={directCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await onAddFiles(e.target.files);
            e.target.value = '';
          }
        }}
        className="hidden"
      />
      <input
        ref={photoGalleryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await onAddFiles(e.target.files);
            e.target.value = '';
          }
        }}
        className="hidden"
      />
      <input
        ref={pdfFileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await onAddFiles(e.target.files);
            e.target.value = '';
          }
        }}
        className="hidden"
      />
      <input
        ref={chatPhotoInputRef}
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || !latestTurn) return;
          e.target.value = '';
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = String(reader.result || '');
            const base64 = dataUrl.includes(',')
              ? dataUrl.split(',')[1]
              : dataUrl;
            await onSendChatMessage(
              latestTurn.id,
              chatInput.trim() ||
                `Enviei esta foto (${file.name}) pelo celular. Analise o que aparece nela e me diga o próximo passo.`,
              {
                base64,
                mimeType: file.type || 'image/jpeg',
                name: file.name,
                sizeBytes: file.size,
                categoryTag: 'FOTO CAMPO',
                previewDataUrl: dataUrl,
              }
            );
            setChatInput('');
          };
          reader.readAsDataURL(file);
        }}
        className="hidden"
      />

      {/* TOP BAR SIMPLES E DIRETA */}
      <header className="sticky top-0 z-30 bg-[#0B111E] border-b border-slate-800 px-3.5 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
            <Smartphone className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white truncate">
              HydroDiag Celular
            </h1>
            <p className="text-[11px] text-slate-400 truncate">
              {screen === 'input'
                ? 'Passo 1 a 3: Informar Falha'
                : 'Resultado: Bornes, PDF e Chat'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onToggleFieldContrast}
            className={`p-2 rounded-lg border text-xs cursor-pointer ${
              fieldContrastMode
                ? 'bg-amber-400 text-slate-950 border-amber-300 font-bold'
                : 'bg-slate-800/90 text-amber-300 border-slate-700'
            }`}
            title="Alto Contraste"
          >
            <Sun className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onExitMobileMode}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <Laptop className="w-3.5 h-3.5 text-sky-400" />
            <span>Versão PC</span>
          </button>
        </div>
      </header>

      {/* CORPO PRINCIPAL */}
      <div className="flex-1 p-3.5 max-w-lg w-full mx-auto space-y-4 pb-10">
        {/* Aviso rápido se tentar abrir PDF sem ter PDF */}
        {mobileNotice && (
          <div className="p-3.5 rounded-xl bg-amber-950/90 border border-amber-500/60 text-xs text-amber-200 flex items-start justify-between gap-2">
            <span>⚠️ {mobileNotice}</span>
            <button
              type="button"
              onClick={() => setMobileNotice(null)}
              className="text-amber-300 font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* Banner de carregamento quando a IA está analisando (com botão direto de Cancelar) */}
        {(isAnalyzing || isUploading) && (
          <div className="p-4 rounded-2xl bg-sky-950/90 border-2 border-sky-500/60 shadow-lg flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Loader2 className="w-6 h-6 text-sky-400 animate-spin shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white">
                  {isUploading
                    ? 'Carregando arquivo...'
                    : 'Analisando falha e localizando bornes...'}
                </p>
                <p className="text-xs text-sky-200 mt-0.5 truncate">
                  {progressStep || 'Aguarde alguns segundos...'}
                </p>
              </div>
            </div>

            {isAnalyzing && (
              <button
                type="button"
                onClick={handleCancelMobileDiagnosis}
                className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1 shrink-0 shadow cursor-pointer"
              >
                <X className="w-4 h-4" />
                <span>Cancelar</span>
              </button>
            )}
          </div>
        )}

        {/* Erro se houver */}
        {error && (
          <div className="p-3.5 rounded-xl bg-rose-950/80 border border-rose-500/60 text-xs text-rose-200 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* BARRA FIXA DE ACESSO DIRETO AO PDF DA USINA (Disponível nas 2 telas!) */}
        {allAvailablePdfAttachments.length > 0 && (
          <div className="p-3 rounded-2xl bg-[#111827] border border-sky-500/40 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-sky-400 font-bold flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5" />
                <span>Abrir Página do Diagrama PDF:</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {allAvailablePdfAttachments.length} PDF(s) disponível(is)
              </span>
            </div>

            {allAvailablePdfAttachments.length > 1 && (
              <select
                aria-label="Selecionar Caderno PDF Elétrico"
                value={selectedMobilePdfId}
                onChange={(e) => setSelectedMobilePdfId(e.target.value)}
                className="w-full bg-[#0B111E] border border-slate-700 rounded-xl px-2.5 py-2 text-xs font-mono text-sky-200 focus:outline-none focus:border-sky-500"
              >
                {allAvailablePdfAttachments.map((pdf, idx) => (
                  <option
                    key={pdf.id}
                    value={pdf.id}
                    className="bg-[#0F172A] text-slate-100"
                  >
                    PDF #{idx + 1}: {pdf.name}
                  </option>
                ))}
              </select>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const rawVal = manualPageInput.trim();
                const explicitFl = rawVal.match(
                  /^(?:fl\.?|folha)\s*#?\s*(\d{1,4})$/i
                );
                const num = parseInt(
                  explicitFl ? explicitFl[1] : rawVal.replace(/[^\d]/g, ''),
                  10
                );
                const validNum = !isNaN(num) && num >= 1 ? num : 1;
                const isFolha =
                  Boolean(explicitFl) || manualInputMode === 'folha';
                const targetPdfObj = allAvailablePdfAttachments.find(
                  (p) => p.id === selectedMobilePdfId
                );
                const batchesToUse = targetPdfObj
                  ? getCachedPdfIndex(targetPdfObj)
                  : combinedMobileCachedBatches;
                const resolved = resolveCitationToPdfPage(
                  validNum,
                  isFolha,
                  latestTurn?.markdownResponse,
                  batchesToUse
                );
                handleOpenMobilePdfSheet(
                  resolved.pdfPage,
                  selectedMobilePdfId || undefined
                );
              }}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setManualInputMode('page')}
                  className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-mono font-bold border cursor-pointer ${
                    manualInputMode === 'page'
                      ? 'bg-sky-500/25 border-sky-400 text-sky-200'
                      : 'bg-[#0B111E] border-slate-800 text-slate-400'
                  }`}
                >
                  Nº da Página PDF
                </button>
                <button
                  type="button"
                  onClick={() => setManualInputMode('folha')}
                  className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-mono font-bold border cursor-pointer ${
                    manualInputMode === 'folha'
                      ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                      : 'bg-[#0B111E] border-slate-800 text-slate-400'
                  }`}
                >
                  Nº da Folha (Selo FL.)
                </button>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={manualPageInput}
                  onChange={(e) => setManualPageInput(e.target.value)}
                  placeholder={
                    manualInputMode === 'folha' ? 'Ex: 29' : 'Ex: 31'
                  }
                  className="w-24 bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-xl px-3 py-2 text-xs font-mono text-white text-center"
                />
                <button
                  type="submit"
                  className="flex-1 py-2 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow cursor-pointer"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>
                    {manualInputMode === 'folha'
                      ? `Abrir Folha FL. ${manualPageInput || 1} no PDF`
                      : `Abrir Pág. ${manualPageInput || 1} do PDF`}
                  </span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ===================================================================
            TELA 1: INFORMAR A FALHA (PASSO 1, PASSO 2 E BOTÃO DE DIAGNÓSTICO)
           =================================================================== */}
        {screen === 'input' && (
          <div className="space-y-4">
            {/* Se já existe um diagnóstico pronto na sessão, mostra botão para voltar a ele */}
            {latestTurn && (
              <button
                type="button"
                onClick={() => setScreen('result')}
                className="w-full py-3 px-4 rounded-xl bg-sky-500/20 border border-sky-500/50 text-sky-200 font-bold text-xs flex items-center justify-between cursor-pointer"
              >
                <span>📋 Ver Diagnóstico Atual Pronto</span>
                <span className="underline">Abrir Resultado →</span>
              </button>
            )}

            {/* Atalho opcional: Abrir falha já salva no PC/Nuvem */}
            {savedInvestigations.length > 0 && (
              <div className="rounded-xl bg-[#111827] border border-slate-800 p-3">
                <button
                  type="button"
                  onClick={() => setShowSavedList((prev) => !prev)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-sky-300 cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-sky-400" />
                    <span>
                      Abrir falha já iniciada no PC ({savedInvestigations.length})
                    </span>
                  </span>
                  <span>{showSavedList ? 'Fechar ▲' : 'Escolher ▼'}</span>
                </button>

                {showSavedList && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-800 space-y-1.5 max-h-52 overflow-y-auto">
                    {savedInvestigations.slice(0, 12).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onLoadInvestigation(item);
                          setShowSavedList(false);
                          setScreen('result');
                        }}
                        className={`w-full text-left p-2.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                          item.id === sessionId
                            ? 'bg-sky-500/20 border-sky-500/50 text-white font-semibold'
                            : 'bg-[#0B111E] border-slate-800 text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        <div className="truncate">{item.title}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {item.attachmentMetadata.length} arq. • Toque para abrir no celular
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* PASSO 1: SUBIR FOTO DO SUPERVISÓRIO OU PDF */}
            <div className="rounded-2xl bg-[#111827] border border-slate-800 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-emerald-500 text-slate-950 font-bold text-xs flex items-center justify-center shrink-0">
                  1
                </span>
                <h2 className="text-sm font-bold text-white">
                  Subir Foto da Falha ou PDF (Opcional)
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => directCameraInputRef.current?.click()}
                  className="p-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex flex-col items-center justify-center gap-1.5 shadow cursor-pointer"
                >
                  <Camera className="w-6 h-6" />
                  <span className="text-center leading-tight">
                    Tirar Foto Agora (Câmera Direta)
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => photoGalleryInputRef.current?.click()}
                  className="p-3.5 rounded-xl bg-[#0B111E] hover:bg-slate-800 border border-emerald-500/40 text-emerald-200 font-semibold text-xs flex flex-col items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ImageIcon className="w-6 h-6 text-emerald-400" />
                  <span className="text-center leading-tight">
                    Subir Foto / Print da Galeria
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => pdfFileInputRef.current?.click()}
                className="w-full py-2.5 px-3 rounded-xl bg-[#0B111E] hover:bg-slate-800 border border-slate-700 text-sky-300 font-medium text-xs flex items-center justify-center gap-2 cursor-pointer"
              >
                <FileText className="w-4 h-4 text-sky-400" />
                <span>Anexar Diagrama Elétrico em PDF</span>
              </button>

              {/* LISTA SEPARADA 1A: FOTOS DA GALERIA / CÂMERA (Abre no Visualizador de Fotos, nunca no PDF!) */}
              {photoAttachments.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <p className="text-xs font-mono text-emerald-400 font-bold">
                    📷 {photoAttachments.length} Foto(s) da Falha anexada(s):
                  </p>
                  {photoAttachments.map((photo) => (
                    <div
                      key={photo.id}
                      className="p-2.5 rounded-xl bg-[#0B111E] border border-emerald-500/40 flex items-center justify-between gap-2.5 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => setPreviewPhotoItem(photo)}
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        {photo.base64Data ? (
                          <img
                            src={`data:${photo.mimeType};base64,${photo.base64Data}`}
                            alt={photo.name}
                            className="w-12 h-12 rounded-lg object-cover border border-slate-700 shrink-0"
                          />
                        ) : (
                          <ImageIcon className="w-5 h-5 text-emerald-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <span className="font-semibold text-white block truncate">
                            {photo.name}
                          </span>
                          <span className="text-[11px] text-emerald-300 flex items-center gap-1">
                            <Eye className="w-3 h-3" />
                            <span>Toque para ampliar a foto</span>
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(photo.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 cursor-pointer shrink-0"
                        title="Remover foto"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* LISTA SEPARADA 1B: CADERNOS PDF ANEXADOS (Abre no Inspetor de PDF!) */}
              {sessionPdfAttachments.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <p className="text-xs font-mono text-sky-400 font-bold">
                    📐 {sessionPdfAttachments.length} Caderno(s) PDF anexado(s):
                  </p>
                  {sessionPdfAttachments.map((pdf) => (
                    <div
                      key={pdf.id}
                      className="p-2.5 rounded-xl bg-[#0B111E] border border-sky-500/40 flex items-center justify-between gap-2.5 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => handleOpenMobilePdfSheet(1, pdf.id)}
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <BookOpen className="w-5 h-5 text-sky-400 shrink-0" />
                        <div className="min-w-0">
                          <span className="font-semibold text-white block truncate">
                            {pdf.name}
                          </span>
                          <span className="text-[11px] text-sky-300">
                            Toque para abrir páginas deste PDF
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(pdf.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 cursor-pointer shrink-0"
                        title="Remover PDF"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* PASSO 2: ESCREVER OU FALAR A FALHA */}
            <div className="rounded-2xl bg-[#111827] border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-sky-500 text-slate-950 font-bold text-xs flex items-center justify-center shrink-0">
                    2
                  </span>
                  <h2 className="text-sm font-bold text-white">
                    Escreva ou Fale qual é a Falha
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={toggleVoiceForQuery}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 border cursor-pointer ${
                    isDictatingQuery
                      ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                      : 'bg-sky-500/20 text-sky-200 border-sky-500/40'
                  }`}
                >
                  {isDictatingQuery ? (
                    <>
                      <MicOff className="w-4 h-4" />
                      <span>Parar Voz</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4 text-sky-400" />
                      <span>Falar no Microfone</span>
                    </>
                  )}
                </button>
              </div>

              {voiceStatus && (
                <div className="px-3 py-1.5 rounded-lg bg-sky-950 border border-sky-500/40 text-xs text-sky-200">
                  🎙️ {voiceStatus}
                </div>
              )}

              {/* Atalhos Rápidos de Campo em 1 Toque (para uso com luva / sem precisar digitar) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-slate-400">
                    Toque rápido (ou digite abaixo):
                  </span>
                  {query.trim() && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="text-[11px] font-mono text-rose-300 hover:text-rose-200 underline cursor-pointer"
                    >
                      Limpar texto
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'Analisar foto do supervisório anexada',
                    'Disjuntor 52G não fecha',
                    'Alarme pressão de óleo UHLM',
                    'Falta 125 Vcc no painel',
                    'Falha Regulador de Velocidade (RV)',
                    'Alarme Nível Poço de Drenagem (SASE)',
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        setQuery(
                          query.trim() ? `${query.trim()} — ${preset}` : preset
                        )
                      }
                      className="px-2.5 py-1 rounded-lg bg-[#0B111E] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 cursor-pointer"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>

              <textarea
                rows={3}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Digite aqui o alarme que apareceu no supervisório (ex: Falha pressão de óleo UHLM, Disjuntor 52G não fecha, Falta 125 Vcc)..."
                className="w-full bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-xl p-3 text-sm text-white placeholder-slate-400 focus:outline-none"
              />
            </div>

            {/* PASSO 3: BOTÃO GIGANTE DE DIAGNOSTICAR (OU CANCELAR SE ESTIVER RODANDO) */}
            {isAnalyzing ? (
              <button
                type="button"
                onClick={handleCancelMobileDiagnosis}
                className="w-full py-4 px-5 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-base flex items-center justify-center gap-2.5 shadow-xl cursor-pointer"
              >
                <X className="w-5 h-5" />
                <span>✕ CANCELAR DIAGNÓSTICO AGORA</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  isUploading || (!query.trim() && attachments.length === 0)
                }
                onClick={() => {
                  userRequestedDiagnosisRef.current = true;
                  onRunDiagnosis(
                    query.trim() ||
                      'Analise a foto/diagrama anexado, identifique a falha e mostre os bornes para testar com o multímetro.'
                  );
                }}
                className="w-full py-4 px-5 rounded-2xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-extrabold text-base flex items-center justify-center gap-2.5 shadow-xl cursor-pointer"
              >
                <Sparkles className="w-5 h-5" />
                <span>3. VER DIAGNÓSTICO E BORNES AGORA</span>
              </button>
            )}
          </div>
        )}

        {/* ===================================================================
            TELA 2: RESULTADO DIRETO (BORNES + ABRIR FOLHA PDF + CHAT WHATSAPP)
           =================================================================== */}
        {screen === 'result' && latestTurn && (
          <div className="space-y-4">
            {/* Barra de Topo do Resultado: Voltar p/ editar, Ouvir no alto-falante ou Cancelar/Limpar */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setScreen('input')}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4 text-sky-400" />
                <span>Voltar / Editar</span>
              </button>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleToggleSpeech}
                  className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 cursor-pointer ${
                    isSpeaking
                      ? 'bg-amber-400 text-slate-950 border-amber-300'
                      : 'bg-sky-500/20 text-sky-200 border-sky-500/40'
                  }`}
                >
                  {isSpeaking ? (
                    <>
                      <VolumeX className="w-4 h-4" />
                      <span>Parar Áudio</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-4 h-4 text-sky-400" />
                      <span>Ouvir Áudio</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    userRequestedDiagnosisRef.current = false;
                    onCancelDiagnosis?.();
                    onNewInvestigation();
                    setScreen('input');
                  }}
                  className="px-3 py-2 rounded-xl bg-rose-600/25 hover:bg-rose-600/40 border border-rose-500/50 text-xs font-bold text-rose-200 flex items-center gap-1 cursor-pointer"
                  title="Cancelar e limpar este diagnóstico para começar do zero"
                >
                  <X className="w-3.5 h-3.5 text-rose-400" />
                  <span>Cancelar / Limpar</span>
                </button>
              </div>
            </div>

            {/* Resumo da Falha Atual + Miniaturas das Fotos da Galeria (se houver) */}
            <div className="p-3.5 rounded-2xl bg-[#111827] border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] font-mono uppercase text-sky-400 block">
                    Falha em Atendimento
                  </span>
                  <h2 className="text-sm font-bold text-white truncate">
                    {latestTurn.userQuery}
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    onUpdateStatus(
                      investigationStatus === 'resolvida'
                        ? 'em_investigacao'
                        : 'resolvida'
                    )
                  }
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border shrink-0 cursor-pointer ${
                    investigationStatus === 'resolvida'
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                      : 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                  }`}
                >
                  {investigationStatus === 'resolvida'
                    ? '✓ Resolvida'
                    : 'Em Campo'}
                </button>
              </div>

              {/* Botão rápido p/ Compartilhar no WhatsApp da Manutenção ou Copiar Resumo */}
              <div className="pt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const bornesText =
                      measurementPoints.length > 0
                        ? measurementPoints
                            .map(
                              (pt, idx) =>
                                `• Ponto #${idx + 1}: Ponta(+) ${pt.terminalOrBorne} | Ponta(-) ${pt.referenceCommon} | Esperado: ${pt.expectedSpec}${pt.pageNumber ? ` (Pág. PDF ${pt.pageNumber})` : ''}`
                            )
                            .join('\n')
                        : 'Ver detalhamento no laudo.';
                    const pagesText =
                      citedPages.length > 0
                        ? citedPages
                            .map(
                              (c) =>
                                `Pág. PDF ${c.pdfPage}${c.folhaSelo ? ` (FL. ${c.folhaSelo})` : ''}`
                            )
                            .join(', ')
                        : 'N/A';
                    const summaryText = [
                      `⚡ *HydroDiag AI — Resumo de Campo PCH/UHE*`,
                      `*Falha:* ${latestTurn.userQuery}`,
                      `*Status:* ${investigationStatus === 'resolvida' ? 'Resolvida' : 'Em Atendimento'}`,
                      `*Folhas Citadas:* ${pagesText}`,
                      `*Bornes p/ Medir com Multímetro:*`,
                      bornesText,
                    ].join('\n');

                    try {
                      if (navigator.share) {
                        await navigator.share({
                          title: `Diagnóstico: ${latestTurn.userQuery}`,
                          text: summaryText,
                        });
                        return;
                      }
                    } catch {
                      // Fallback to clipboard
                    }
                    try {
                      await navigator.clipboard.writeText(summaryText);
                      setMobileNotice(
                        'Resumo com bornes e páginas copiado! Agora é só colar no WhatsApp da equipe.'
                      );
                      setTimeout(() => setMobileNotice(null), 4000);
                    } catch {
                      // Ignore
                    }
                  }}
                  className="w-full py-2 px-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Compartilhar / Copiar Resumo p/ WhatsApp</span>
                </button>
              </div>

              {photoAttachments.length > 0 && (
                <div className="pt-2 border-t border-slate-800 flex items-center gap-2 overflow-x-auto">
                  {photoAttachments.map((photo) => (
                    <button
                      key={photo.id}
                      type="button"
                      onClick={() => setPreviewPhotoItem(photo)}
                      className="px-2.5 py-1.5 rounded-lg bg-[#0B111E] border border-emerald-500/40 text-emerald-200 text-xs flex items-center gap-1.5 shrink-0 cursor-pointer"
                    >
                      <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="truncate max-w-[150px]">
                        Ver Foto: {photo.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* BLOCO 1: BORNES PARA MEDIR COM MULTÍMETRO + BOTÃO DIRETO DA PÁGINA DO PDF */}
            <div className="p-4 rounded-2xl bg-[#111827] border-2 border-amber-500/40 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono uppercase tracking-wider text-amber-400 font-bold">
                  📟 1. Onde Medir com o Multímetro (Bornes)
                </h3>
                {probeSummary?.locationPage && (
                  <button
                    type="button"
                    onClick={() =>
                      handleOpenMobilePdfSheet(probeSummary.locationPage!)
                    }
                    className="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-mono font-bold text-xs flex items-center gap-1 cursor-pointer"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>Abrir Pág. {probeSummary.locationPage}</span>
                  </button>
                )}
              </div>

              {measurementPoints.length > 0 ? (
                <div className="space-y-2">
                  {measurementPoints.map((pt, idx) => (
                    <div
                      key={pt.id}
                      className="p-3 rounded-xl bg-[#0B111E] border border-slate-800 flex items-center justify-between gap-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="text-[11px] font-mono font-bold text-sky-400 block">
                          PONTO #{idx + 1} — {pt.stepLabel}
                        </span>
                        <p className="text-xs font-mono text-amber-300 mt-0.5">
                          🔴 Ponta (+): {pt.terminalOrBorne}
                        </p>
                        <p className="text-xs text-slate-300 mt-0.5">
                          ⚫ Ponta (-): {pt.referenceCommon}
                        </p>
                        <p className="text-xs text-emerald-300 font-mono font-bold mt-1">
                          Esperado: {pt.expectedSpec}
                        </p>
                      </div>

                      {pt.pageNumber && (
                        <button
                          type="button"
                          onClick={() =>
                            handleOpenMobilePdfSheet(pt.pageNumber!)
                          }
                          className="px-3 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs flex flex-col items-center justify-center shrink-0 shadow cursor-pointer"
                        >
                          <BookOpen className="w-4 h-4 mb-0.5" />
                          <span>Pág. {pt.pageNumber}</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-300">
                  Veja os detalhes de medição no laudo abaixo ou toque em uma
                  página do PDF.
                </p>
              )}

              {/* Botões grandes para abrir qualquer folha citada do PDF */}
              <div className="pt-2 border-t border-slate-800 space-y-2">
                <span className="text-xs font-bold text-sky-300 block">
                  📐 Folhas do Diagrama PDF citadas neste diagnóstico:
                </span>

                {citedPages.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {citedPages.map((item) => (
                      <button
                        key={item.pdfPage}
                        type="button"
                        onClick={() => handleOpenMobilePdfSheet(item.pdfPage)}
                        className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs flex items-center gap-1.5 shadow cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>
                          Abrir Pág. {item.pdfPage}
                          {item.folhaSelo && item.folhaSelo !== item.pdfPage
                            ? ` (FL. ${item.folhaSelo})`
                            : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : allAvailablePdfAttachments.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {allAvailablePdfAttachments.map((pdf, idx) => (
                      <button
                        key={pdf.id}
                        type="button"
                        onClick={() => handleOpenMobilePdfSheet(1, pdf.id)}
                        className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs flex items-center gap-1.5 shadow cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>Abrir PDF #{idx + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => pdfFileInputRef.current?.click()}
                    className="w-full py-2.5 px-3 rounded-xl bg-sky-500/20 border border-sky-500/40 text-sky-200 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <FileText className="w-4 h-4 text-sky-400" />
                    <span>+ Anexar Diagrama PDF para abrir as páginas</span>
                  </button>
                )}
              </div>
            </div>

            {/* BLOCO 2: LAUDO TÉCNICO COMPLETO (COM PÁGINAS CLICÁVEIS) */}
            <div className="p-4 rounded-2xl bg-[#111827] border border-slate-800 space-y-2.5">
              <button
                type="button"
                onClick={() => setShowFullLaudo((prev) => !prev)}
                className="w-full flex items-center justify-between text-left cursor-pointer"
              >
                <span className="text-xs font-mono uppercase tracking-wider text-slate-200 font-bold">
                  📋 2. Explicação Completa e Passo a Passo
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-xs font-mono text-sky-400">
                  {showFullLaudo ? 'Ocultar ▲' : 'Ler Tudo ▼'}
                </span>
              </button>

              {showFullLaudo && (
                <div className="pt-2.5 border-t border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {renderTextWithClickablePdfPages(latestTurn.markdownResponse)}
                </div>
              )}
            </div>

            {/* BLOCO 3: RESPOSTA RÁPIDA DE CAMPO & CHAT (ESTILO WHATSAPP) */}
            <div className="p-4 rounded-2xl bg-[#111827] border border-slate-800 space-y-3">
              <h3 className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-bold">
                💬 3. O que você encontrou no painel? (Conte p/ a IA)
              </h3>

              {/* 2 Botões rápidos de medição */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isChatSending}
                  onClick={() =>
                    onSendChatMessage(
                      latestTurn.id,
                      'Medi 125 Vcc (tensão normal) neste borne. Qual o próximo borne a jusante devo medir agora?'
                    )
                  }
                  className="py-2.5 px-3 rounded-xl bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-500/50 text-emerald-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Tem 125 Vcc (OK)</span>
                </button>

                <button
                  type="button"
                  disabled={isChatSending}
                  onClick={() =>
                    onSendChatMessage(
                      latestTurn.id,
                      'Medi 0 Vcc (sem tensão) neste borne. Qual contato ou fusível antes dele está aberto?'
                    )
                  }
                  className="py-2.5 px-3 rounded-xl bg-rose-600/25 hover:bg-rose-600/35 border border-rose-500/50 text-rose-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>Deu 0 Vcc (Falha)</span>
                </button>
              </div>

              {/* Histórico de mensagens do Chat (com páginas clicáveis!) */}
              {(latestTurn.chatMessages || []).length > 0 && (
                <div className="max-h-72 overflow-y-auto space-y-2 pt-2 border-t border-slate-800">
                  {(latestTurn.chatMessages || []).map((msg) => (
                    <div
                      key={msg.id}
                      className={`p-3 rounded-xl text-xs leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-sky-600/25 border border-sky-500/40 text-sky-100 ml-6'
                          : 'bg-[#0B111E] border border-slate-800 text-slate-200 mr-2 whitespace-pre-wrap'
                      }`}
                    >
                      <div className="text-[10px] font-mono text-slate-400 mb-1">
                        {msg.role === 'user' ? '👷 Você' : '⚡ Engenheiro IA'}
                      </div>
                      {renderTextWithClickablePdfPages(msg.content)}
                    </div>
                  ))}
                </div>
              )}

              {isChatSending && (
                <div className="p-3 rounded-xl bg-sky-950/60 border border-sky-500/40 flex items-center gap-2 text-xs text-sky-200">
                  <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" />
                  <span>
                    {chatProgressStep || 'Analisando sua resposta...'}
                  </span>
                </div>
              )}

              {/* Barra estilo WhatsApp: Foto + Microfone + Texto + Enviar */}
              <form
                onSubmit={handleSendMobileChat}
                className="flex items-center gap-1.5 pt-1"
              >
                <button
                  type="button"
                  onClick={() => chatPhotoInputRef.current?.click()}
                  className="p-2.5 rounded-xl bg-emerald-600/25 border border-emerald-500/40 text-emerald-300 shrink-0 cursor-pointer"
                  title="Enviar foto direto no chat"
                >
                  <Camera className="w-5 h-5" />
                </button>

                <button
                  type="button"
                  onClick={toggleVoiceForChat}
                  className={`p-2.5 rounded-xl border shrink-0 cursor-pointer ${
                    isDictatingChat
                      ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                      : 'bg-[#0B111E] text-sky-400 border-slate-700'
                  }`}
                  title="Falar por voz"
                >
                  {isDictatingChat ? (
                    <MicOff className="w-5 h-5" />
                  ) : (
                    <Mic className="w-5 h-5" />
                  )}
                </button>

                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Pergunte ou digite a medição..."
                  className="flex-1 min-w-0 bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none"
                />

                <button
                  type="submit"
                  disabled={!chatInput.trim() || isChatSending}
                  className="p-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white shrink-0 cursor-pointer"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </div>
        )}
      </div>

      {/* MODAL DEDICADO PARA VER FOTO DA GALERIA / CÂMERA (Separado do PDF!) */}
      {previewPhotoItem && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col p-3">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="min-w-0">
              <span className="text-[10px] font-mono uppercase text-emerald-400 block">
                Foto da Galeria / Câmera
              </span>
              <h3 className="text-xs font-bold text-white truncate">
                {previewPhotoItem.name}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setPreviewPhotoItem(null)}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
            >
              <X className="w-4 h-4" />
              <span>Fechar Foto</span>
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center overflow-auto p-2">
            {previewPhotoItem.base64Data ? (
              <img
                src={`data:${previewPhotoItem.mimeType};base64,${previewPhotoItem.base64Data}`}
                alt={previewPhotoItem.name}
                className="max-w-full max-h-full object-contain rounded-lg"
              />
            ) : (
              <p className="text-xs text-slate-400">
                Imagem sem pré-visualização local.
              </p>
            )}
          </div>
        </div>
      )}

      {/* INSPETOR DE FOLHA PDF (Recebe EXCLUSIVAMENTE allAvailablePdfAttachments — Zero Fotos da Galeria!) */}
      <PdfDeepLinkDrawer
        isOpen={mobilePdfOpen}
        onClose={() => setMobilePdfOpen(false)}
        attachments={allAvailablePdfAttachments}
        initialPage={mobilePdfPage}
        initialAttachmentId={mobilePdfAttachmentId}
        reportMarkdown={latestTurn?.markdownResponse}
        onAskAboutCurrentPage={
          latestTurn
            ? (pageNum, attName) => {
                setMobilePdfOpen(false);
                setScreen('result');
                onSendChatMessage(
                  latestTurn.id,
                  `Inspecionei a Página ${pageNum} do arquivo "${attName}" no Inspetor Deep-Link. Detalhe os bornes de medição (+ / -), contatos NA/NF e referências cruzadas visíveis nesta folha para isolar a falha.`
                );
              }
            : undefined
        }
        onRequestReupload={() => {
          setMobilePdfOpen(false);
          pdfFileInputRef.current?.click();
        }}
        onRelinkAttachmentBinary={onRelinkAttachmentBinary}
      />
    </div>
  );
};
