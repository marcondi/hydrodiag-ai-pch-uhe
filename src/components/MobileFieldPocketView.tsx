import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Camera,
  CheckCircle2,
  ChevronRight,
  Cpu,
  FileText,
  Image as ImageIcon,
  Laptop,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Zap,
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

type PocketTab = 'alarme' | 'bornes' | 'folhas' | 'chat';

const QUICK_SCADA_ALARMS = [
  'Alarme Supervisório: Falha de Pressão de Óleo na UHLM / Disparo 86',
  'Disjuntor 52G não fecha pelo supervisório (verificar intertravamento e bobina)',
  'Falta de tensão 125 Vcc na régua de bornes / entrada digital do CLP-SASE',
  'Falha de comunicação ou cartão de entrada digital (XED) sem sinal no painel',
  'Relé de bloqueio 86 atuado — rastrear qual contato disparou a bobina',
];

const QUICK_MOBILE_CHAT_CHIPS = [
  'Medi 125 Vcc neste borne. Qual o próximo ponto a jusante?',
  'Medi 0 Vcc neste borne. Qual contato ou fusível a montante abriu?',
  'Onde fica fisicamente este componente no painel (/ME) e qual o código (/RM)?',
  'É seguro fazer este teste com a máquina rodando ou há risco de Trip?',
];

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
  isSyncingCloud,
  onSyncCloud,
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
  const [activeTab, setActiveTab] = useState<PocketTab>(() =>
    turns.length > 0 ? 'bornes' : 'alarme'
  );
  const [manualPageInput, setManualPageInput] = useState<string>('1');
  const [chatInput, setChatInput] = useState<string>('');
  const [isDictatingQuery, setIsDictatingQuery] = useState<boolean>(false);
  const [isDictatingChat, setIsDictatingChat] = useState<boolean>(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [showFullReportMobile, setShowFullReportMobile] =
    useState<boolean>(false);
  const [mobilePdfOpen, setMobilePdfOpen] = useState<boolean>(false);
  const [mobilePdfPage, setMobilePdfPage] = useState<number>(1);
  const [mobilePdfAttachmentId, setMobilePdfAttachmentId] = useState<
    string | undefined
  >(undefined);

  const handleOpenMobilePdfSheet = (
    pageNumber: number,
    attachmentId?: string
  ) => {
    setMobilePdfPage(pageNumber);
    setMobilePdfAttachmentId(attachmentId);
    setMobilePdfOpen(true);
    onOpenPdfPage(pageNumber, attachmentId);
  };

  const scadaPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const pdfUploadInputRef = useRef<HTMLInputElement | null>(null);
  const voiceEngineRef = useRef<UniversalVoiceDictation | null>(null);
  const queryRef = useRef<string>(query);
  queryRef.current = query;
  const chatInputRef = useRef<string>(chatInput);
  chatInputRef.current = chatInput;

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const prevTurnsCountRef = useRef<number>(turns.length);

  // Automatically jump to "Bornes & Multímetro" tab when a new diagnostic turn arrives
  useEffect(() => {
    if (turns.length > prevTurnsCountRef.current && turns.length > 0) {
      setActiveTab('bornes');
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

  const handleQuickMeasurementReply = async (measurementMsg: string) => {
    if (!latestTurn) return;
    setActiveTab('chat');
    await onSendChatMessage(latestTurn.id, measurementMsg);
  };

  const handleSendMobileChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = chatInput.trim();
    if (!text || !latestTurn || isChatSending) return;
    stopVoice();
    setChatInput('');
    await onSendChatMessage(latestTurn.id, text);
  };

  return (
    <div className="min-h-screen bg-[#070B14] text-slate-100 flex flex-col pb-20 select-none">
      {/* Hidden Direct Inputs for Supervisorio Photo & PDF */}
      <input
        ref={scadaPhotoInputRef}
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
        ref={pdfUploadInputRef}
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

      {/* Top Mobile Header */}
      <header className="sticky top-0 z-30 bg-[#0B111E]/95 backdrop-blur-md border-b border-slate-800 px-3 py-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <Smartphone className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-white truncate">
                  HydroDiag Campo
                </span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-mono text-emerald-300 shrink-0">
                  CELULAR
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                {latestTurn
                  ? latestTurn.userQuery
                  : 'Pronto p/ foto do Supervisório ou consulta'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onToggleFieldContrast}
              className={`p-2 rounded-lg border cursor-pointer ${
                fieldContrastMode
                  ? 'bg-amber-400 text-slate-950 border-amber-300'
                  : 'bg-[#111827] text-amber-400 border-slate-700'
              }`}
              title="Alternar Alto Contraste de Campo"
            >
              <Sun className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onSyncCloud}
              disabled={isSyncingCloud}
              className="p-2 rounded-lg bg-[#111827] border border-slate-700 text-emerald-400 cursor-pointer"
              title="Sincronizar com Notebook (Supabase)"
            >
              <RefreshCw
                className={`w-4 h-4 ${isSyncingCloud ? 'animate-spin' : ''}`}
              />
            </button>

            <button
              type="button"
              onClick={onExitMobileMode}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-mono font-semibold text-sky-300 flex items-center gap-1 cursor-pointer"
              title="Voltar para a versão completa de Notebook / Bancada"
            >
              <Laptop className="w-3.5 h-3.5" />
              <span>Bancada PC</span>
            </button>
          </div>
        </div>

        {/* Quick Recent Investigations Selector & New Button */}
        <div className="flex items-center gap-2">
          <select
            aria-label="Selecionar investigação sincronizada"
            value={
              turns.length > 0 &&
              savedInvestigations.some((i) => i.id === sessionId)
                ? sessionId
                : ''
            }
            onChange={(e) => {
              const found = savedInvestigations.find(
                (i) => i.id === e.target.value
              );
              if (found) {
                onLoadInvestigation(found);
                setActiveTab('bornes');
              }
            }}
            className="flex-1 bg-[#111827] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-sky-200 font-mono truncate focus:outline-none"
          >
            <option value="">
              📂 Investigações Sincronizadas ({savedInvestigations.length})...
            </option>
            {savedInvestigations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.status === 'resolvida' ? '✓ ' : '⚡ '}
                {item.title}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              onNewInvestigation();
              setActiveTab('alarme');
            }}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nova</span>
          </button>
        </div>
      </header>

      {/* Live Analysis / Upload Banner */}
      {(isAnalyzing || isUploading) && (
        <div className="mx-3 mt-3 p-3.5 rounded-xl bg-sky-950/80 border-2 border-sky-500/60 flex items-center gap-3 shadow-lg">
          <Loader2 className="w-6 h-6 text-sky-400 animate-spin shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-white">
              {isUploading
                ? 'Carregando foto / diagrama...'
                : 'Engenheiro IA analisando falha e bornes...'}
            </p>
            <p className="text-[11px] font-mono text-sky-300 truncate">
              {progressStep || 'Rastreando réguas de bornes e folhas PDF...'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mx-3 mt-3 p-3 rounded-xl bg-rose-950/80 border border-rose-500/60 text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Main Tab Body */}
      <div className="flex-1 p-3 space-y-3 max-w-xl w-full mx-auto">
        {/* =====================================================================
            ABA 1: FALHA / SUPERVISÓRIO (SUBIR FOTO DA FALHA OU ESCREVER/DITAR)
           ===================================================================== */}
        {activeTab === 'alarme' && (
          <div className="space-y-3">
            {/* Step 1: Giant Photo / Upload Buttons */}
            <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-3 shadow-lg">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-bold flex items-center gap-1.5">
                  <Camera className="w-4 h-4" />
                  <span>1. Foto da Falha no Supervisório / Painel</span>
                </h2>
                <span className="text-[11px] font-mono text-slate-400">
                  {attachments.length} arq.
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* Button A: Open Field Camera with Red Pen to photograph SCADA / Panel */}
                <button
                  type="button"
                  onClick={onOpenFieldCamera}
                  className="w-full py-3.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2.5 shadow-lg cursor-pointer active:scale-[0.99]"
                >
                  <Camera className="w-5 h-5 shrink-0" />
                  <span>Fotografar Supervisório / Painel</span>
                </button>

                {/* Button B: Quick Gallery Upload (Print of SCADA or PDF) */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => scadaPhotoInputRef.current?.click()}
                    className="py-3 px-2.5 rounded-xl bg-[#0B111E] hover:bg-slate-800 border border-emerald-500/40 text-emerald-200 font-semibold text-xs flex flex-col items-center justify-center gap-1 cursor-pointer"
                  >
                    <ImageIcon className="w-4 h-4 text-emerald-400" />
                    <span>Subir Foto/Print</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => pdfUploadInputRef.current?.click()}
                    className="py-3 px-2.5 rounded-xl bg-[#0B111E] hover:bg-slate-800 border border-sky-500/40 text-sky-200 font-semibold text-xs flex flex-col items-center justify-center gap-1 cursor-pointer"
                  >
                    <Upload className="w-4 h-4 text-sky-400" />
                    <span>Subir PDF (/EL)</span>
                  </button>
                </div>
              </div>

              {/* Attached Files List */}
              {attachments.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                  <p className="text-[11px] font-mono text-slate-400">
                    Arquivos anexados nesta investigação (toque para abrir):
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {attachments.map((att) => (
                      <div
                        key={att.id}
                        className="px-3 py-2 rounded-lg bg-[#0B111E] border border-slate-800 flex items-center justify-between gap-2"
                      >
                        <button
                          type="button"
                          onClick={() => onOpenPdfPage(1, att.id)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <BookOpen className="w-4 h-4 text-sky-400 shrink-0" />
                          <div className="min-w-0">
                            <span className="text-xs font-mono font-semibold text-slate-100 block truncate">
                              #{att.sequenceIndex} {att.name}
                            </span>
                            <span className="text-[10px] font-mono text-sky-400">
                              {att.categoryTag}{' '}
                              {att.panelName ? `• ${att.panelName}` : ''} (Toque
                              p/ abrir)
                            </span>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveAttachment(att.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-400 cursor-pointer"
                          title="Remover arquivo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Step 2: Write or Dictate the Fault from SCADA / Field */}
            <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-3 shadow-lg">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-mono uppercase tracking-wider text-sky-400 font-bold flex items-center gap-1.5">
                  <Zap className="w-4 h-4" />
                  <span>2. Escrever ou Ditar a Falha / Alarme</span>
                </h2>

                <button
                  type="button"
                  onClick={toggleVoiceForQuery}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 border cursor-pointer ${
                    isDictatingQuery
                      ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                      : 'bg-sky-500/20 text-sky-200 border-sky-500/40'
                  }`}
                >
                  {isDictatingQuery ? (
                    <>
                      <MicOff className="w-3.5 h-3.5" />
                      <span>Parar Voz</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5 text-sky-400" />
                      <span>Ditar por Voz</span>
                    </>
                  )}
                </button>
              </div>

              {voiceStatus && isDictatingQuery && (
                <div className="px-3 py-1.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-xs font-mono text-rose-200">
                  🎙️ {voiceStatus}
                </div>
              )}

              <textarea
                rows={3}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Escreva aqui o alarme que apareceu no Supervisório / IHM ou o sintoma em campo (ex: Alarme Falha Pressão de Óleo UHLM, relé 86 atuado, disjuntor 52G não fecha)..."
                className="w-full rounded-xl bg-[#0B111E] border border-slate-700 focus:border-sky-500 p-3 text-sm text-white placeholder:text-slate-500 focus:outline-none"
              />

              {/* Quick Alarm Presets */}
              <div className="space-y-1">
                <span className="text-[11px] font-mono text-slate-400 block">
                  Ou toque em um alarme rápido:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_SCADA_ALARMS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setQuery(preset)}
                      className="text-left px-2.5 py-1.5 rounded-lg bg-[#0B111E] hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 cursor-pointer"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Giant Run Diagnosis Button */}
              <button
                type="button"
                disabled={isAnalyzing || isUploading}
                onClick={() => onRunDiagnosis()}
                className="w-full py-4 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-base flex items-center justify-center gap-2 shadow-xl cursor-pointer active:scale-[0.99]"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Diagnosticando Falha...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    <span>Diagnosticar Falha Agora</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* =====================================================================
            ABA 2: BORNES & MULTÍMETRO (PONTOS DE PROVA + ÁUDIO + RESPOSTA RÁPIDA)
           ===================================================================== */}
        {activeTab === 'bornes' && (
          <div className="space-y-3">
            {!latestTurn ? (
              <div className="p-6 rounded-xl bg-[#111827] border border-slate-800 text-center space-y-3">
                <Cpu className="w-10 h-10 text-sky-400 mx-auto" />
                <h3 className="text-sm font-bold text-white">
                  Nenhum diagnóstico aberto ainda
                </h3>
                <p className="text-xs text-slate-400">
                  Suba uma foto da falha no Supervisório, escreva o alarme na
                  aba <strong>Falha / Supervisório</strong> ou selecione uma
                  investigação sincronizada no topo.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('alarme')}
                  className="px-4 py-2.5 rounded-xl bg-sky-600 text-white text-xs font-bold cursor-pointer"
                >
                  Ir para Falha / Supervisório
                </button>
              </div>
            ) : (
              <>
                {/* Active Fault Header Card + Audio Read Aloud */}
                <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-sky-400 font-bold">
                        FALHA EM INVESTIGAÇÃO
                      </span>
                      <h2 className="text-sm font-bold text-white mt-0.5">
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
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold border shrink-0 cursor-pointer ${
                        investigationStatus === 'resolvida'
                          ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                          : 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      }`}
                    >
                      {investigationStatus === 'resolvida'
                        ? '✓ Resolvida'
                        : '⚡ Em Campo'}
                    </button>
                  </div>

                  {/* Giant Audio Speaker Button + Quick Camera Button */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleToggleSpeech}
                      className={`py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 border cursor-pointer ${
                        isSpeaking
                          ? 'bg-amber-500 text-slate-950 border-amber-300'
                          : 'bg-[#0B111E] text-sky-200 border-sky-500/40'
                      }`}
                    >
                      {isSpeaking ? (
                        <>
                          <VolumeX className="w-4 h-4 shrink-0" />
                          <span>Parar Leitura</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-4 h-4 text-sky-400 shrink-0" />
                          <span>Ouvir no Alto-Falante</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={onOpenFieldCamera}
                      className="py-2.5 px-3 rounded-xl bg-emerald-600/25 border border-emerald-500/50 text-emerald-200 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Camera className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Fotografar Borne</span>
                    </button>
                  </div>
                </div>

                {/* Circuit Division Checkpoints (Ponto #1, Ponto #2, Ponto #3) */}
                {measurementPoints.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono uppercase tracking-wider text-amber-400 font-bold">
                        📟 Guia Rápido de Ponta de Prova (Bornes)
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        Toque na Pág. p/ abrir PDF
                      </span>
                    </div>

                    <div className="space-y-2">
                      {measurementPoints.map((pt, idx) => (
                        <div
                          key={pt.id}
                          className="p-3 rounded-xl bg-[#0B111E] border border-slate-800 flex items-center justify-between gap-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-mono text-[10px] font-bold">
                                PONTO #{idx + 1}
                              </span>
                              <span className="text-xs font-bold text-white truncate">
                                {pt.stepLabel}
                              </span>
                            </div>
                            <p className="text-xs font-mono text-amber-300 mt-1">
                              (+) {pt.terminalOrBorne}
                            </p>
                            <p className="text-[11px] text-slate-300 mt-0.5">
                              (-) {pt.referenceCommon} • Esperado:{' '}
                              <strong className="text-emerald-300 font-mono">
                                {pt.expectedSpec}
                              </strong>
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
                  </div>
                )}

                {/* Quick Cited Pages Bar */}
                {citedPages.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2">
                    <span className="text-xs font-mono uppercase tracking-wider text-sky-400 font-bold block">
                      📐 Abrir Folha do PDF Direto nos Bornes Citados:
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {citedPages.map((pg) => (
                        <button
                          key={pg}
                          type="button"
                          onClick={() => handleOpenMobilePdfSheet(pg)}
                          className="px-3.5 py-2 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/50 text-sky-200 font-mono font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                        >
                          <BookOpen className="w-3.5 h-3.5 text-sky-400" />
                          <span>Abrir Pág. {pg}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 1-Tap Multimeter Feedback Buttons */}
                <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2">
                  <span className="text-xs font-mono uppercase tracking-wider text-emerald-400 font-bold block">
                    ⚡ Informar Leitura do Multímetro (1 Toque):
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isChatSending}
                      onClick={() =>
                        handleQuickMeasurementReply(
                          'Medi 125 Vcc (tensão normal) no borne inicial. Qual o próximo borne a jusante devo medir agora?'
                        )
                      }
                      className="py-3 px-3 rounded-xl bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-500/50 text-emerald-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Mediu 125 Vcc (OK)</span>
                    </button>

                    <button
                      type="button"
                      disabled={isChatSending}
                      onClick={() =>
                        handleQuickMeasurementReply(
                          'Medi 0 Vcc (sem tensão / aberto) neste borne. Qual contato, fusível ou relé a montante está bloqueando o sinal?'
                        )
                      }
                      className="py-3 px-3 rounded-xl bg-rose-600/25 hover:bg-rose-600/35 border border-rose-500/50 text-rose-200 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>Mediu 0 Vcc (Falha)</span>
                    </button>
                  </div>
                </div>

                {/* Full Diagnostic Text (Collapsible or Direct View) */}
                <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
                  <button
                    type="button"
                    onClick={() => setShowFullReportMobile((prev) => !prev)}
                    className="w-full flex items-center justify-between text-left cursor-pointer"
                  >
                    <span className="text-xs font-mono uppercase tracking-wider text-slate-200 font-bold">
                      📋 Laudo Técnico Completo (Passo a Passo)
                    </span>
                    <span className="text-xs font-mono text-sky-400">
                      {showFullReportMobile ? 'Recolher ▲' : 'Expandir ▼'}
                    </span>
                  </button>

                  {showFullReportMobile && (
                    <div className="pt-2 border-t border-slate-800 text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans space-y-2">
                      {latestTurn.markdownResponse}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* =====================================================================
            ABA 3: FOLHAS PDF & ANOTAÇÕES DE CAMPO
           ===================================================================== */}
        {activeTab === 'folhas' && (
          <div className="space-y-3">
            {/* Direct Page Number Launcher */}
            <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
              <h2 className="text-xs font-mono uppercase tracking-wider text-sky-400 font-bold flex items-center gap-1.5">
                <BookOpen className="w-4 h-4" />
                <span>Abrir Página Específica do PDF (Com Anotações)</span>
              </h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const num = parseInt(manualPageInput, 10);
                  if (!isNaN(num) && num >= 1) {
                    handleOpenMobilePdfSheet(num);
                  }
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="number"
                  min={1}
                  value={manualPageInput}
                  onChange={(e) => setManualPageInput(e.target.value)}
                  placeholder="Nº da página..."
                  className="w-28 bg-[#0B111E] border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-mono text-white text-center focus:outline-none focus:border-sky-500"
                />
                <button
                  type="submit"
                  className="flex-1 py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm flex items-center justify-center gap-2 cursor-pointer"
                >
                  <BookOpen className="w-4 h-4" />
                  <span>Abrir Folha #{manualPageInput || 1}</span>
                </button>
              </form>
            </div>

            {/* Cited Pages in Current Diagnosis */}
            {citedPages.length > 0 && (
              <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
                <span className="text-xs font-mono uppercase tracking-wider text-amber-400 font-bold block">
                  Folhas Citadas no Diagnóstico Atual:
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {citedPages.map((pg) => (
                    <button
                      key={pg}
                      type="button"
                      onClick={() => handleOpenMobilePdfSheet(pg)}
                      className="p-3 rounded-xl bg-[#0B111E] hover:bg-sky-500/20 border border-sky-500/40 text-left flex items-center justify-between cursor-pointer"
                    >
                      <div>
                        <span className="text-xs font-mono font-bold text-sky-300 block">
                          Página {pg}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Ver diagrama / bornes
                        </span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-sky-400" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Attached PDFs / Photos List */}
            <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono uppercase tracking-wider text-slate-300 font-bold">
                  Cadernos PDF e Fotos Anexadas ({attachments.length})
                </span>
                <button
                  type="button"
                  onClick={() => pdfUploadInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-lg bg-sky-500/20 border border-sky-500/40 text-xs font-mono text-sky-300 cursor-pointer"
                >
                  + Anexar PDF
                </button>
              </div>

              {attachments.length === 0 ? (
                <p className="text-xs text-slate-400 py-3 text-center">
                  Nenhum arquivo anexado ainda. Toque em "+ Anexar PDF" acima.
                </p>
              ) : (
                <div className="space-y-2">
                  {attachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      onClick={() => handleOpenMobilePdfSheet(1, att.id)}
                      className="w-full p-3 rounded-xl bg-[#0B111E] hover:bg-slate-800 border border-slate-800 flex items-center justify-between gap-2 text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText className="w-5 h-5 text-sky-400 shrink-0" />
                        <div className="min-w-0">
                          <span className="text-xs font-mono font-bold text-white block truncate">
                            #{att.sequenceIndex} {att.name}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            {att.categoryTag} • Toque para inspecionar e anotar
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =====================================================================
            ABA 4: CHAT RÁPIDO DE CAMPO & VOZ COM O ENGENHEIRO IA
           ===================================================================== */}
        {activeTab === 'chat' && (
          <div className="space-y-3">
            {!latestTurn ? (
              <div className="p-6 rounded-xl bg-[#111827] border border-slate-800 text-center space-y-3">
                <MessageSquare className="w-10 h-10 text-sky-400 mx-auto" />
                <p className="text-xs text-slate-300">
                  Inicie primeiro o diagnóstico na aba{' '}
                  <strong>Falha / Supervisório</strong> para conversar com o
                  Engenheiro Especialista sobre os bornes.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('alarme')}
                  className="px-4 py-2 rounded-xl bg-sky-600 text-white text-xs font-bold cursor-pointer"
                >
                  Subir Falha / Iniciar
                </button>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-[#111827] border border-slate-800 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono uppercase tracking-wider text-sky-400 font-bold">
                    💬 Chat de Campo c/ Engenheiro IA
                  </span>
                  <button
                    type="button"
                    onClick={onOpenFieldCamera}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs font-mono flex items-center gap-1 cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Enviar Foto</span>
                  </button>
                </div>

                {/* Messages History */}
                <div className="max-h-[42vh] overflow-y-auto space-y-2.5 pr-1">
                  {(latestTurn.chatMessages || []).length === 0 ? (
                    <p className="text-xs text-slate-400 py-4 text-center">
                      Toque em uma pergunta rápida abaixo ou dite o valor medido
                      no multímetro.
                    </p>
                  ) : (
                    (latestTurn.chatMessages || []).map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-3 rounded-xl text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-sky-600/25 border border-sky-500/40 text-sky-100 ml-4'
                            : 'bg-[#0B111E] border border-slate-800 text-slate-200 mr-2 whitespace-pre-wrap'
                        }`}
                      >
                        <div className="text-[10px] font-mono text-slate-400 mb-1">
                          {msg.role === 'user'
                            ? '👷 Você em Campo'
                            : '⚡ Engenheiro IA'}
                        </div>
                        {msg.content}
                      </div>
                    ))
                  )}

                  {isChatSending && (
                    <div className="p-3 rounded-xl bg-sky-950/60 border border-sky-500/40 flex items-center gap-2 text-xs text-sky-200">
                      <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" />
                      <span>
                        {chatProgressStep || 'Engenheiro analisando medição...'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Quick Field Questions */}
                <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800">
                  {QUICK_MOBILE_CHAT_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      disabled={isChatSending}
                      onClick={() => onSendChatMessage(latestTurn.id, chip)}
                      className="text-left px-2.5 py-1.5 rounded-lg bg-[#0B111E] hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-200 cursor-pointer"
                    >
                      + {chip}
                    </button>
                  ))}
                </div>

                {/* Voice + Text Input Bar */}
                <form
                  onSubmit={handleSendMobileChat}
                  className="flex items-center gap-2 pt-1"
                >
                  <button
                    type="button"
                    onClick={toggleVoiceForChat}
                    className={`p-3 rounded-xl border shrink-0 cursor-pointer ${
                      isDictatingChat
                        ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                        : 'bg-[#0B111E] text-sky-400 border-slate-700'
                    }`}
                    title="Ditar mensagem por voz"
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
                    placeholder="Escreva ou dite a leitura (ex: 0 Vcc em X2:65)..."
                    className="flex-1 bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none"
                  />

                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isChatSending}
                    className="p-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white shrink-0 cursor-pointer"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Thumb Navigation Bar (4 Large Buttons for One-Hand Operation) */}
      <nav className="fixed bottom-0 inset-x-0 z-30 bg-[#0B111E]/95 backdrop-blur-md border-t border-slate-800 px-2 py-1.5 grid grid-cols-4 gap-1.5 no-print">
        <button
          type="button"
          onClick={() => setActiveTab('alarme')}
          className={`py-2 px-1 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer transition-colors ${
            activeTab === 'alarme'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Camera className="w-4 h-4" />
          <span>1. Supervisório</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('bornes')}
          className={`py-2 px-1 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer transition-colors ${
            activeTab === 'bornes'
              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Cpu className="w-4 h-4" />
          <span>2. Bornes/Laudo</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('folhas')}
          className={`py-2 px-1 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer transition-colors ${
            activeTab === 'folhas'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>3. Folha PDF</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('chat')}
          className={`py-2 px-1 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer transition-colors ${
            activeTab === 'chat'
              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>4. Chat/Voz</span>
        </button>
      </nav>

      {/* Interactive PDF Sheet Deep-Link Drawer (Mobile Mode) */}
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
                setActiveTab('chat');
                onSendChatMessage(
                  latestTurn.id,
                  `Inspecionei a Página ${pageNum} do arquivo "${attName}" no Inspetor Deep-Link. Detalhe os bornes de medição (+ / -), contatos NA/NF e referências cruzadas visíveis nesta folha para isolar a falha.`
                );
              }
            : undefined
        }
        onRequestReupload={() => {
          setMobilePdfOpen(false);
          setActiveTab('alarme');
        }}
        onRelinkAttachmentBinary={onRelinkAttachmentBinary}
      />
    </div>
  );
};
