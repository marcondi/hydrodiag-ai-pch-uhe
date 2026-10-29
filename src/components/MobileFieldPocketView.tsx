import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Camera,
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Laptop,
  Loader2,
  Mic,
  MicOff,
  Send,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
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
} from '../utils/pdfClientEngine';
import { UniversalVoiceDictation } from '../utils/voiceDictationEngine';
import { technicalSpeechEngine } from '../utils/speechSynthesisEngine';
import { PdfDeepLinkDrawer } from './PdfDeepLinkDrawer';

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

function extractCitedPagesFromMarkdown(markdown: string): number[] {
  const pages = new Set<number>();
  const regex =
    /\b(?:P[áa]g(?:ina)?s?\.?|Fl(?:s)?\.?|Folha)\s*#?\s*(\d{1,4})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num) && num >= 1 && num <= 2000) {
      pages.add(num);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
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
  onOpenFieldCamera,
  onOpenPdfPage,
  onRelinkAttachmentBinary,
  onSendChatMessage,
  onExitMobileMode,
}) => {
  // Two simple screens: 'input' (Passo 1, 2, 3 para enviar a falha) or 'result' (Bornes + PDF + Chat)
  const [screen, setScreen] = useState<'input' | 'result'>(() =>
    turns.length > 0 ? 'result' : 'input'
  );
  const [showSavedList, setShowSavedList] = useState<boolean>(false);
  const [showFullLaudo, setShowFullLaudo] = useState<boolean>(false);
  const [manualPageInput, setManualPageInput] = useState<string>('');
  const [chatInput, setChatInput] = useState<string>('');
  const [isDictatingQuery, setIsDictatingQuery] = useState<boolean>(false);
  const [isDictatingChat, setIsDictatingChat] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);

  // Mobile PDF Drawer state
  const [mobilePdfOpen, setMobilePdfOpen] = useState<boolean>(false);
  const [mobilePdfPage, setMobilePdfPage] = useState<number>(1);
  const [mobilePdfAttachmentId, setMobilePdfAttachmentId] = useState<
    string | undefined
  >(undefined);

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

  // Automatically switch to Result screen when diagnosis completes
  useEffect(() => {
    if (turns.length > prevTurnsCountRef.current && turns.length > 0) {
      setScreen('result');
    }
    prevTurnsCountRef.current = turns.length;
  }, [turns.length]);

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

  const handleOpenMobilePdfSheet = (
    pageNumber: number,
    attachmentId?: string
  ) => {
    setMobilePdfPage(pageNumber);
    setMobilePdfAttachmentId(attachmentId);
    setMobilePdfOpen(true);
    onOpenPdfPage(pageNumber, attachmentId);
  };

  const handleToggleSpeech = () => {
    if (!latestTurn) return;
    technicalSpeechEngine.toggleSpeak(
      latestTurn.id,
      latestTurn.markdownResponse
    );
  };

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
    ? extractCitedPagesFromMarkdown(latestTurn.markdownResponse)
    : [];

  const handleSendMobileChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = chatInput.trim();
    if (!text || !latestTurn || isChatSending) return;
    stopVoice();
    setChatInput('');
    await onSendChatMessage(latestTurn.id, text);
  };

  return (
    <div className="min-h-screen bg-[#070B14] text-slate-100 flex flex-col">
      {/* Hidden File Inputs (Direct Native Camera, Gallery & PDF — No blocking modal!) */}
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
        accept=".pdf,application/pdf,image/*"
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
                ? '1. Envie a falha para diagnosticar'
                : '2. Guia de Bornes, Folha PDF e Chat'}
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
        {/* Banner de carregamento quando a IA está analisando */}
        {(isAnalyzing || isUploading) && (
          <div className="p-4 rounded-2xl bg-sky-950/90 border-2 border-sky-500/60 shadow-lg flex items-center gap-3">
            <Loader2 className="w-6 h-6 text-sky-400 animate-spin shrink-0" />
            <div>
              <p className="text-sm font-bold text-white">
                {isUploading
                  ? 'Carregando foto / arquivo PDF...'
                  : 'Analisando falha e localizando bornes...'}
              </p>
              <p className="text-xs text-sky-200 mt-0.5">
                {progressStep || 'Aguarde alguns segundos...'}
              </p>
            </div>
          </div>
        )}

        {/* Erro se houver */}
        {error && (
          <div className="p-3.5 rounded-xl bg-rose-950/80 border border-rose-500/60 text-xs text-rose-200 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
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
                <span>📋 Você já tem um diagnóstico aberto nesta sessão</span>
                <span className="underline">Ver Resultado →</span>
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

              {/* Lista de arquivos/fotos já anexados com miniatura direta */}
              {attachments.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <p className="text-xs font-mono text-emerald-400 font-bold">
                    ✅ {attachments.length} arquivo(s) pronto(s) para análise:
                  </p>
                  {attachments.map((att) => {
                    const isImage = att.mimeType.startsWith('image/');
                    return (
                      <div
                        key={att.id}
                        className="p-2.5 rounded-xl bg-[#0B111E] border border-emerald-500/40 flex items-center justify-between gap-2.5 text-xs"
                      >
                        <button
                          type="button"
                          onClick={() => handleOpenMobilePdfSheet(1, att.id)}
                          className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          {isImage && att.base64Data ? (
                            <img
                              src={`data:${att.mimeType};base64,${att.base64Data}`}
                              alt={att.name}
                              className="w-12 h-12 rounded-lg object-cover border border-slate-700 shrink-0"
                            />
                          ) : (
                            <BookOpen className="w-5 h-5 text-sky-400 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="font-semibold text-white block truncate">
                              {att.name}
                            </span>
                            <span className="text-[11px] text-emerald-300">
                              Pronto! Agora vá ao Passo 2 ou clique no botão 3 abaixo
                            </span>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveAttachment(att.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-400 cursor-pointer shrink-0"
                          title="Remover arquivo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
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

              <textarea
                rows={3}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Digite aqui o alarme que apareceu no supervisório (ex: Falha pressão de óleo UHLM, Disjuntor 52G não fecha, Falta 125 Vcc)..."
                className="w-full bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-xl p-3 text-sm text-white placeholder-slate-400 focus:outline-none"
              />
            </div>

            {/* PASSO 3: BOTÃO GIGANTE DE DIAGNOSTICAR */}
            <button
              type="button"
              disabled={
                isAnalyzing ||
                isUploading ||
                (!query.trim() && attachments.length === 0)
              }
              onClick={() =>
                onRunDiagnosis(
                  query.trim() ||
                    'Analise a foto/diagrama anexado, identifique a falha e mostre os bornes para testar com o multímetro.'
                )
              }
              className="w-full py-4 px-5 rounded-2xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-extrabold text-base flex items-center justify-center gap-2.5 shadow-xl cursor-pointer"
            >
              <Sparkles className="w-5 h-5" />
              <span>3. VER DIAGNÓSTICO E BORNES AGORA</span>
            </button>
          </div>
        )}

        {/* ===================================================================
            TELA 2: RESULTADO DIRETO (BORNES + ABRIR FOLHA PDF + CHAT WHATSAPP)
           =================================================================== */}
        {screen === 'result' && latestTurn && (
          <div className="space-y-4">
            {/* Barra de Topo do Resultado: Voltar p/ enviar outra falha ou Ouvir no alto-falante */}
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setScreen('input')}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4 text-sky-400" />
                <span>Subir Foto / Trocar Falha</span>
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
                    onNewInvestigation();
                    setScreen('input');
                  }}
                  className="px-2.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs text-slate-300 cursor-pointer"
                  title="Nova Investigação Limpa"
                >
                  + Nova
                </button>
              </div>
            </div>

            {/* Resumo da Falha Atual + Status */}
            <div className="p-3.5 rounded-2xl bg-[#111827] border border-slate-800 flex items-center justify-between gap-2">
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
                    <span>Ver Pág. {probeSummary.locationPage}</span>
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
                  Veja os detalhes de medição no laudo abaixo ou abra a folha do
                  PDF.
                </p>
              )}

              {/* Botões grandes para abrir qualquer folha citada do PDF */}
              {(citedPages.length > 0 || attachments.length > 0) && (
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <span className="text-xs font-bold text-sky-300 block">
                    📐 Toque para abrir o Desenho PDF (Zoom e Anotações):
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {citedPages.map((pg) => (
                      <button
                        key={pg}
                        type="button"
                        onClick={() => handleOpenMobilePdfSheet(pg)}
                        className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs flex items-center gap-1.5 shadow cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>Abrir Pág. {pg}</span>
                      </button>
                    ))}
                    {citedPages.length === 0 &&
                      attachments.map((att) => (
                        <button
                          key={att.id}
                          type="button"
                          onClick={() => handleOpenMobilePdfSheet(1, att.id)}
                          className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-xs flex items-center gap-1.5 shadow cursor-pointer"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Abrir PDF #{att.sequenceIndex}</span>
                        </button>
                      ))}
                  </div>

                  {/* Digitar nº de página direto se quiser outra folha */}
                  {attachments.length > 0 && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const n = parseInt(manualPageInput, 10);
                        if (!isNaN(n) && n >= 1) {
                          handleOpenMobilePdfSheet(n);
                        }
                      }}
                      className="flex items-center gap-2 pt-1"
                    >
                      <input
                        type="number"
                        min={1}
                        value={manualPageInput}
                        onChange={(e) => setManualPageInput(e.target.value)}
                        placeholder="Ir p/ pág. nº..."
                        className="w-32 bg-[#0B111E] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-sky-300 font-semibold cursor-pointer"
                      >
                        Abrir Folha
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>

            {/* BLOCO 2: LAUDO TÉCNICO COMPLETO (EXPANSÍVEL COM 1 TOQUE) */}
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
                  {latestTurn.markdownResponse}
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

              {/* Histórico de mensagens do Chat */}
              {(latestTurn.chatMessages || []).length > 0 && (
                <div className="max-h-64 overflow-y-auto space-y-2 pt-2 border-t border-slate-800">
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
                      {msg.content}
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

      {/* Inspetor de Folha PDF com Zoom, Desenho, Caixa de Texto e Print p/ Campo */}
      <PdfDeepLinkDrawer
        isOpen={mobilePdfOpen}
        onClose={() => setMobilePdfOpen(false)}
        attachments={attachments}
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
          setScreen('input');
        }}
        onRelinkAttachmentBinary={onRelinkAttachmentBinary}
      />
    </div>
  );
};
