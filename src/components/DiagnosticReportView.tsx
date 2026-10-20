import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Printer,
  Copy,
  Check,
  PlusCircle,
  AlertTriangle,
  FileSearch,
  Clock,
  ChevronRight,
  CheckCircle2,
  BookmarkCheck,
  Columns2,
  FileText,
  MessageSquare,
  Rows2,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
  Activity,
  Zap,
} from 'lucide-react';
import {
  ChatAttachmentPayload,
  DiagramAttachment,
  DiagnosticTurn,
  InvestigationStatus,
} from '../types';
import { FaultChatPanel } from './FaultChatPanel';
import { PdfDeepLinkDrawer } from './PdfDeepLinkDrawer';
import {
  extractProbeSummaryFromMarkdown,
  formatTechnicalSymbols,
  linkifyPdfPageReferences,
} from '../utils/pdfClientEngine';

export type WorkspaceLayoutMode = 'split' | 'report' | 'chat' | 'stacked';

interface DiagnosticReportViewProps {
  turns: DiagnosticTurn[];
  attachments: DiagramAttachment[];
  isAnalyzing: boolean;
  progressStep?: string;
  error: string | null;
  onOpenSequenceUpload: () => void;
  onQuickFollowUp: (promptText: string) => Promise<void>;
  onSendChatMessage: (
    turnId: string,
    messageText: string,
    attachment?: ChatAttachmentPayload
  ) => Promise<void>;
  isChatSending: boolean;
  chatProgressStep?: string;
  investigationStatus: InvestigationStatus;
  onUpdateStatus: (status: InvestigationStatus) => void;
  fieldResolutionNote: string;
  onUpdateResolutionNote: (note: string) => void;
  isLeftSidebarCollapsed?: boolean;
  onToggleLeftSidebar?: () => void;
}

export const DiagnosticReportView: React.FC<DiagnosticReportViewProps> = ({
  turns,
  attachments,
  isAnalyzing,
  progressStep,
  error,
  onOpenSequenceUpload,
  onQuickFollowUp,
  onSendChatMessage,
  isChatSending,
  chatProgressStep,
  investigationStatus,
  onUpdateStatus,
  fieldResolutionNote,
  onUpdateResolutionNote,
  isLeftSidebarCollapsed = false,
  onToggleLeftSidebar,
}) => {
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number | null>(
    null
  );
  const [noteSavedToast, setNoteSavedToast] = useState(false);
  const [workspaceMode, setWorkspaceMode] =
    useState<WorkspaceLayoutMode>('split');
  const [deepLinkOpen, setDeepLinkOpen] = useState<boolean>(false);
  const [deepLinkPage, setDeepLinkPage] = useState<number>(1);

  const handleOpenPdfDeepLink = (pageNumber: number) => {
    setDeepLinkPage(Math.max(1, pageNumber));
    setDeepLinkOpen(true);
  };

  const activeTurnIndex =
    selectedTurnIndex !== null && selectedTurnIndex < turns.length
      ? selectedTurnIndex
      : turns.length - 1;

  const activeTurn = turns[activeTurnIndex] || null;

  const handleCopyMarkdown = async (turn: DiagnosticTurn) => {
    try {
      await navigator.clipboard.writeText(
        formatTechnicalSymbols(turn.markdownResponse)
      );
      setCopiedTurnId(turn.id);
      setTimeout(() => setCopiedTurnId(null), 2000);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const renderReportPaneContent = (turn: DiagnosticTurn) => {
    const probeSummary = extractProbeSummaryFromMarkdown(turn.markdownResponse);

    return (
      <div className="flex flex-col gap-4">
        {/* Active Query Context Summary Box */}
        <div className="p-3 rounded-md bg-[#0B111E] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
              <Clock className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>{new Date(turn.timestamp).toLocaleString('pt-BR')}</span>
              <span>·</span>
              <span className="truncate">
                {turn.attachedFileNames.length > 0
                  ? turn.attachedFileNames.join(', ')
                  : 'Consulta técnica direta'}
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-100">
              Alarme / Consulta: &quot;{turn.userQuery}&quot;
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0 no-print">
            {attachments.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  handleOpenPdfDeepLink(probeSummary?.locationPage || 1)
                }
                className="px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                title="Abrir Inspetor Interativo de Folhas do PDF"
              >
                <BookOpen className="w-3.5 h-3.5 text-sky-400" />
                <span>Inspetor de Folhas PDF</span>
              </button>
            )}
            <div className="flex items-center gap-1 text-xs text-emerald-400 font-mono">
              <BookmarkCheck className="w-4 h-4" />
              <span>Salvo na Nuvem</span>
            </div>
          </div>
        </div>

        {/* ITEM 3: PAINEL VISUAL DE "PONTA DE PROVA" (RESUMO RÁPIDO NO TOPO DO LAUDO) */}
        {probeSummary && (
          <div
            aria-label="Painel Visual de Ponta de Prova"
            className="rounded-lg bg-[#0B111E] border border-slate-800 p-3.5 flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-100">
                  Painel Rápido de Ponta de Prova (Multímetro em Campo)
                </span>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className="text-xs font-mono tabular-nums text-sky-300">
                  Régua / Bornes: {probeSummary.terminalStrip}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono tabular-nums text-slate-400">
                  Terminais: {probeSummary.contactsOrComponent}
                </span>
                {probeSummary.locationPage && attachments.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      handleOpenPdfDeepLink(probeSummary.locationPage!)
                    }
                    className="px-2 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 font-mono text-[11px] tabular-nums flex items-center gap-1 cursor-pointer transition-colors no-print"
                    title={`Abrir ${probeSummary.locationLabel} no Inspetor Deep-Link`}
                  >
                    <FileSearch className="w-3 h-3 text-sky-400" />
                    <span>{probeSummary.locationLabel}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* Ponta de Prova Vermelha (+) */}
              <div className="p-2.5 rounded-md bg-rose-950/25 border border-rose-800/50 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-mono font-semibold text-rose-300">
                    PONTA VERMELHA (+)
                  </span>
                  <span className="text-[10px] font-mono text-rose-400/90">
                    Sinal / Positivo
                  </span>
                </div>
                <p className="text-xs font-mono tabular-nums text-slate-100 leading-snug">
                  {probeSummary.redProbe}
                </p>
              </div>

              {/* Ponta de Prova Preta (-) */}
              <div className="p-2.5 rounded-md bg-slate-900/90 border border-slate-700/80 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-mono font-semibold text-slate-300">
                    PONTA PRETA (-)
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    Comum / Referência
                  </span>
                </div>
                <p className="text-xs font-mono tabular-nums text-slate-200 leading-snug">
                  {probeSummary.blackProbe}
                </p>
              </div>

              {/* Leitura Esperada no Multímetro */}
              <div className="p-2.5 rounded-md bg-emerald-950/25 border border-emerald-800/50 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-mono font-semibold text-emerald-300 flex items-center gap-1">
                    <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                    <span>LEITURA ESPERADA</span>
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400/90">
                    Escala Vcc / Vca / Ω
                  </span>
                </div>
                <p className="text-xs font-mono tabular-nums font-semibold text-emerald-200 leading-snug">
                  {probeSummary.expectedValue}
                </p>
              </div>
            </div>
          </div>
        )}

      {/* Markdown Content with Industrial Styling + Interactive PDF Page Deep-Links */}
      <div className="prose prose-invert max-w-none text-sm leading-relaxed text-slate-200 space-y-4">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h3: ({ children }) => (
              <h3 className="text-base font-bold text-slate-100 bg-slate-900/90 border border-slate-700/80 rounded-md px-4 py-2.5 mt-5 mb-3 tracking-tight">
                {children}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="text-sm font-semibold text-sky-300 mt-4 mb-2">
                {children}
              </h4>
            ),
            p: ({ children }) => (
              <p className="text-sm text-slate-200 leading-relaxed mb-3">
                {children}
              </p>
            ),
            ul: ({ children }) => (
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-200 mb-4">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-200 mb-4">
                {children}
              </ol>
            ),
            li: ({ children }) => (
              <li className="leading-relaxed text-slate-200">{children}</li>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-white">{children}</strong>
            ),
            code: ({ children, className }) => {
              const isBlock = className && className.includes('language-');
              if (isBlock) {
                return (
                  <pre className="bg-[#0B111E] border border-slate-800 rounded-md p-3.5 overflow-x-auto my-3">
                    <code className="text-xs font-mono tabular-nums text-sky-300">
                      {children}
                    </code>
                  </pre>
                );
              }
              return (
                <code className="px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-sky-300 font-mono text-xs tabular-nums">
                  {children}
                </code>
              );
            },
            a: ({ href, children }) => {
              if (href && href.startsWith('#pdf-page-')) {
                const pageNum = parseInt(href.replace('#pdf-page-', ''), 10);
                return (
                  <button
                    type="button"
                    onClick={() => {
                      if (!isNaN(pageNum)) {
                        handleOpenPdfDeepLink(pageNum);
                      }
                    }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-sky-500/15 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-mono text-xs tabular-nums transition-colors cursor-pointer align-baseline no-print"
                    title={`Clique para abrir e inspecionar a Página ${pageNum} do PDF em alta resolução`}
                  >
                    <FileSearch className="w-3 h-3 text-sky-400 shrink-0" />
                    <span>{children}</span>
                  </button>
                );
              }
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 underline"
                >
                  {children}
                </a>
              );
            },
            table: ({ children }) => (
              <div className="overflow-x-auto my-4 border border-slate-800 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-slate-900 text-slate-300 border-b border-slate-800 font-semibold">
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="px-3.5 py-2.5 border-r border-slate-800 last:border-r-0">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-3.5 py-2 border-t border-r border-slate-800 last:border-r-0 font-mono tabular-nums text-slate-200">
                {children}
              </td>
            ),
            blockquote: ({ children }) => (
              <blockquote className="p-3.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs my-3">
                {children}
              </blockquote>
            ),
          }}
        >
          {linkifyPdfPageReferences(
            formatTechnicalSymbols(turn.markdownResponse)
          )}
        </ReactMarkdown>
      </div>

      {/* Alerta de Próximo PDF Necessário / Sequência de Desenhos */}
      <div className="p-3.5 rounded-lg bg-amber-950/30 border border-amber-700/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 no-print">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <h4 className="text-xs font-semibold text-amber-200">
              Continuidade de Sinal / Próximo Desenho na Sequência
            </h4>
          </div>
          <p className="text-xs text-amber-100/80 leading-relaxed">
            O sinal saiu pela régua de bornes para outro painel (ex:{' '}
            <code>PCPG1</code>, <code>CLP-SASE</code>, <code>QDCC</code>)?
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenSequenceUpload}
            className="px-3 py-1.5 text-xs font-medium text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>Anexar Próximo Desenho</span>
          </button>

          <button
            type="button"
            onClick={() =>
              onQuickFollowUp(
                'Detalhe o rastreamento completo dos bornes de saída e informe qual folha ou documento externo deve ser verificado na sequência.'
              )
            }
            className="px-2.5 py-1.5 text-xs font-medium text-amber-200 bg-amber-900/40 hover:bg-amber-900/60 border border-amber-700/50 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            Detalhar Bornes de Saída
          </button>
        </div>
      </div>

      {/* Field Resolution Note Box (Saved in Fault History DB) */}
      <div className="p-3.5 rounded-lg bg-[#0B111E] border border-slate-800 flex flex-col gap-2 no-print">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="field-resolution-note"
            className="text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>
              Registro de Resolução em Campo / Causa Raiz Confirmada (Salvo no
              Supabase)
            </span>
          </label>
          {noteSavedToast && (
            <span className="text-[11px] text-emerald-400 font-mono">
              Salvo automaticamente
            </span>
          )}
        </div>
        <input
          id="field-resolution-note"
          type="text"
          value={fieldResolutionNote}
          onChange={(e) => {
            onUpdateResolutionNote(e.target.value);
            setNoteSavedToast(true);
            setTimeout(() => setNoteSavedToast(false), 1800);
          }}
          placeholder="Ex: Substituído disjuntor motor Q12 desarmado / Normalizada fonte 24Vcc do Switch na Folha 31..."
          className="w-full bg-[#111827] border border-slate-700 focus:border-emerald-500 rounded-md px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
      </div>
    </div>
    );
  };

  return (
    <section
      aria-label="Painel de Resultado do Diagnóstico"
      className="bg-[#111827] border border-slate-800 rounded-lg flex flex-col min-h-[620px] lg:h-[calc(100vh-128px)] overflow-hidden print-surface"
    >
      {/* Top Control Bar of Diagnostic Workspace */}
      <div className="px-4 py-2.5 border-b border-slate-800 bg-[#111827] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleLeftSidebar && (
            <button
              type="button"
              onClick={onToggleLeftSidebar}
              className={`px-2.5 py-1 rounded border text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 no-print ${
                isLeftSidebarCollapsed
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                  : 'bg-[#0B111E] border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
              title={
                isLeftSidebarCollapsed
                  ? 'Mostrar painel de Upload e Consulta na esquerda'
                  : 'Expandir Bancada em 100% da tela (Modo Split-Workspace)'
              }
            >
              {isLeftSidebarCollapsed ? (
                <>
                  <PanelLeftOpen className="w-3.5 h-3.5 text-sky-400" />
                  <span>Abrir Entrada</span>
                </>
              ) : (
                <>
                  <PanelLeftClose className="w-3.5 h-3.5 text-slate-400" />
                  <span>Tela Cheia</span>
                </>
              )}
            </button>
          )}

          <div className="min-w-0 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100 truncate">
              Bancada Split-Workspace (Laudo Técnico &amp; Chat Especialista)
            </h2>
            {attachments.length > 0 && (
              <span className="hidden sm:inline text-[11px] font-mono tabular-nums text-sky-400 shrink-0">
                · {attachments.length} arq.
              </span>
            )}
          </div>
        </div>

        {activeTurn && (
          <div className="flex flex-wrap items-center gap-2 no-print">
            {/* Segmented Split-Workspace View Switcher */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#0B111E] border border-slate-800 rounded-md">
              <button
                type="button"
                onClick={() => setWorkspaceMode('split')}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                  workspaceMode === 'split'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Exibir Laudo Técnico na esquerda e Chat do Engenheiro na direita com rolagem independente"
              >
                <Columns2 className="w-3.5 h-3.5" />
                <span>Lado a Lado</span>
              </button>

              <button
                type="button"
                onClick={() => setWorkspaceMode('report')}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                  workspaceMode === 'report'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Focar apenas no Laudo Técnico em tela cheia"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Só Laudo</span>
              </button>

              <button
                type="button"
                onClick={() => setWorkspaceMode('chat')}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                  workspaceMode === 'chat'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Focar apenas no Chat com o Engenheiro Eletricista"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>
                  Só Chat ({activeTurn.chatMessages?.length || 0})
                </span>
              </button>

              <button
                type="button"
                onClick={() => setWorkspaceMode('stacked')}
                className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                  workspaceMode === 'stacked'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Modo empilhado tradicional (Laudo em cima, Chat embaixo)"
              >
                <Rows2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Empilhado</span>
              </button>
            </div>

            {/* Status selector */}
            <select
              aria-label="Status da Falha"
              value={investigationStatus}
              onChange={(e) =>
                onUpdateStatus(e.target.value as InvestigationStatus)
              }
              className={`text-xs font-medium rounded-md px-2.5 py-1 border focus:outline-none cursor-pointer ${
                investigationStatus === 'resolvida'
                  ? 'bg-emerald-950/60 border-emerald-600/60 text-emerald-300'
                  : investigationStatus === 'aguardando_peca'
                    ? 'bg-amber-950/60 border-amber-600/60 text-amber-300'
                    : 'bg-slate-800 border-slate-700 text-slate-200'
              }`}
            >
              <option value="em_investigacao">Em Investigação</option>
              <option value="resolvida">Resolvida em Campo</option>
              <option value="aguardando_peca">Aguardando Peça</option>
            </select>

            <button
              type="button"
              onClick={() => handleCopyMarkdown(activeTurn)}
              className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              title="Copiar texto do laudo"
            >
              {copiedTurnId === activeTurn.id ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-400" />
                  <span>Copiar</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              title="Imprimir Ordem de Serviço"
            >
              <Printer className="w-3.5 h-3.5 text-sky-400" />
              <span>OS</span>
            </button>
          </div>
        )}
      </div>

      {/* Sequential Investigation Breadcrumb / Turn Switcher */}
      {turns.length > 1 && (
        <div className="px-4 py-1.5 bg-[#0B111E]/70 border-b border-slate-800 flex items-center gap-2 overflow-x-auto shrink-0 no-print">
          <span className="text-xs text-slate-400 shrink-0">
            Etapas da Investigação:
          </span>
          {turns.map((turn, idx) => {
            const isCurrent = idx === activeTurnIndex;
            return (
              <React.Fragment key={turn.id}>
                {idx > 0 && (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setSelectedTurnIndex(idx)}
                  className={`px-2.5 py-0.5 rounded text-xs font-mono tabular-nums transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isCurrent
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  Etapa #{idx + 1} ({turn.sequenceCountAtTurn} arq.)
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="m-4 p-3.5 rounded-lg bg-rose-950/40 border border-rose-800/70 text-rose-200 flex items-start gap-3 shrink-0">
          <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-1 text-xs">
            <p className="font-semibold text-rose-100">
              Erro ao Processar Diagnóstico
            </p>
            <p className="text-rose-200/90 leading-relaxed">{error}</p>
          </div>
        </div>
      )}

      {/* Loading State with Live Step Feedback */}
      {isAnalyzing && (
        <div className="p-8 flex-1 flex flex-col justify-center items-center text-center gap-4">
          <div className="w-12 h-12 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 animate-spin">
            <FileSearch className="w-6 h-6" />
          </div>
          <div className="max-w-lg space-y-2">
            <h3 className="text-sm font-semibold text-slate-100">
              {progressStep ||
                'Rastreando Barramentos de Comando e Referências Cruzadas...'}
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              O sistema especialista está inspecionando folhas funcionais (
              <code>/EL</code>), réguas de bornes (<code>/RB</code>), layout
              mecânico (<code>/ME</code>) e relação de materiais (
              <code>/RM</code>) para localizar bornes de medição e manobras de
              correção.
            </p>
          </div>

          <div className="w-full max-w-lg grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
            <div className="p-3 rounded border border-slate-800 bg-[#0B111E]/60 text-left">
              <p className="text-[11px] font-mono text-sky-400">
                1. VARREDURA /EL &amp; /RB
              </p>
              <p className="text-xs text-slate-300 mt-0.5">
                Localizando Folha, Página do PDF e Coordenada (Linha A–F, Coluna
                1–8)
              </p>
            </div>
            <div className="p-3 rounded border border-slate-800 bg-[#0B111E]/60 text-left">
              <p className="text-[11px] font-mono text-amber-400">
                2. PONTA DE PROVA &amp; MANOBRA
              </p>
              <p className="text-xs text-slate-300 mt-0.5">
                Mapeando bornes (+) / (-), contatos NA/NF e intertravamentos
                Kirk
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isAnalyzing && !activeTurn && !error && (
        <div className="p-8 flex-1 flex flex-col justify-center items-center text-center">
          <div className="max-w-xl space-y-5">
            <div className="w-12 h-12 mx-auto rounded-lg bg-slate-800/80 border border-slate-700 flex items-center justify-center text-sky-400">
              <FileSearch className="w-6 h-6" />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-slate-100">
                Pronto para Diagnóstico Eletromecânico em Split-Workspace
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Anexe o caderno de diagramas em PDF ou foto de campo na coluna à
                esquerda e informe o alarme do supervisório (ou reabra uma falha
                recente na barra superior) para dividir a tela entre o{' '}
                <strong>Laudo Técnico</strong> e o{' '}
                <strong>Chat com o Engenheiro Eletricista</strong> sem rolagem
                vertical excessiva.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
              <div className="p-3.5 rounded-md border border-slate-800 bg-[#0B111E]/60">
                <p className="text-xs font-semibold text-slate-200">
                  Guia de Ponta de Prova (Multímetro)
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Indicação exata da régua de bornes (<code>1X2</code>,{' '}
                  <code>2X2</code>, <code>XED</code>), terminais{' '}
                  <code>13-14</code> / <code>21-22</code> e tensão esperada (
                  <code>125 Vcc</code> / <code>24 Vcc</code>).
                </p>
              </div>

              <div className="p-3.5 rounded-md border border-slate-800 bg-[#0B111E]/60">
                <p className="text-xs font-semibold text-slate-200">
                  Zero Rolagem Excessiva (Lado a Lado)
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  O Laudo e o Chat possuem barras de rolagem independentes na
                  mesma tela para que você leia os bornes enquanto conversa com
                  o especialista.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Populated Workspace: Supports Split-View, Report-Only, Chat-Only, and Stacked */}
      {!isAnalyzing && activeTurn && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* MODE 1: SPLIT-VIEW (SIDE BY SIDE ON DESKTOP lg+, INDEPENDENT SCROLL PANES) */}
          {workspaceMode === 'split' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
              {/* Left Pane: Technical Diagnostic Report (Independent Scroll) */}
              <div className="lg:col-span-7 h-full overflow-y-auto p-4 sm:p-5 flex flex-col gap-5">
                {renderReportPaneContent(activeTurn)}
              </div>

              {/* Right Pane: Pinned Real-Time Electrical Engineer Chat (Independent Scroll) */}
              <div className="lg:col-span-5 h-full overflow-hidden flex flex-col bg-[#0B111E]/50">
                <FaultChatPanel
                  alarmTitle={activeTurn.userQuery}
                  messages={activeTurn.chatMessages || []}
                  onSendMessage={(text, attachment) =>
                    onSendChatMessage(activeTurn.id, text, attachment)
                  }
                  onOpenSequenceUpload={onOpenSequenceUpload}
                  onOpenPdfDeepLink={handleOpenPdfDeepLink}
                  isSending={isChatSending}
                  chatProgressStep={chatProgressStep}
                  fillHeight={true}
                />
              </div>
            </div>
          )}

          {/* MODE 2: REPORT ONLY */}
          {workspaceMode === 'report' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-5">
              {renderReportPaneContent(activeTurn)}
            </div>
          )}

          {/* MODE 3: CHAT ONLY */}
          {workspaceMode === 'chat' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <FaultChatPanel
                alarmTitle={activeTurn.userQuery}
                messages={activeTurn.chatMessages || []}
                onSendMessage={(text, attachment) =>
                  onSendChatMessage(activeTurn.id, text, attachment)
                }
                onOpenSequenceUpload={onOpenSequenceUpload}
                onOpenPdfDeepLink={handleOpenPdfDeepLink}
                isSending={isChatSending}
                chatProgressStep={chatProgressStep}
                fillHeight={true}
              />
            </div>
          )}

          {/* MODE 4: CLASSIC STACKED */}
          {workspaceMode === 'stacked' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-6">
              {renderReportPaneContent(activeTurn)}
              <FaultChatPanel
                alarmTitle={activeTurn.userQuery}
                messages={activeTurn.chatMessages || []}
                onSendMessage={(text, attachment) =>
                  onSendChatMessage(activeTurn.id, text, attachment)
                }
                onOpenSequenceUpload={onOpenSequenceUpload}
                onOpenPdfDeepLink={handleOpenPdfDeepLink}
                isSending={isChatSending}
                chatProgressStep={chatProgressStep}
                fillHeight={false}
              />
            </div>
          )}
        </div>
      )}

      {/* Interactive PDF Sheet Deep-Link Drawer */}
      <PdfDeepLinkDrawer
        isOpen={deepLinkOpen}
        onClose={() => setDeepLinkOpen(false)}
        attachments={attachments}
        initialPage={deepLinkPage}
        onAskAboutCurrentPage={
          activeTurn
            ? (pageNum, attName) => {
                onSendChatMessage(
                  activeTurn.id,
                  `Inspecionei a Página ${pageNum} do arquivo "${attName}" no Inspetor Deep-Link. Detalhe os bornes de medição (+ / -), contatos NA/NF e referências cruzadas visíveis nesta folha para isolar a falha.`
                );
              }
            : undefined
        }
        onRequestReupload={() => {
          if (onToggleLeftSidebar && isLeftSidebarCollapsed) {
            onToggleLeftSidebar();
          }
        }}
      />
    </section>
  );
};
