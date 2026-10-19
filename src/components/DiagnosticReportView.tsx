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
} from 'lucide-react';
import {
  ChatAttachmentPayload,
  DiagramAttachment,
  DiagnosticTurn,
  InvestigationStatus,
} from '../types';
import { FaultChatPanel } from './FaultChatPanel';

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
}) => {
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number | null>(
    null
  );
  const [noteSavedToast, setNoteSavedToast] = useState(false);

  const activeTurnIndex =
    selectedTurnIndex !== null && selectedTurnIndex < turns.length
      ? selectedTurnIndex
      : turns.length - 1;

  const activeTurn = turns[activeTurnIndex] || null;

  const handleCopyMarkdown = async (turn: DiagnosticTurn) => {
    try {
      await navigator.clipboard.writeText(turn.markdownResponse);
      setCopiedTurnId(turn.id);
      setTimeout(() => setCopiedTurnId(null), 2000);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <section
      aria-label="Painel de Resultado do Diagnóstico"
      className="bg-[#111827] border border-slate-800 rounded-lg flex flex-col min-h-[680px] print-surface"
    >
      {/* Top Bar of Diagnostic Result Panel */}
      <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            3. Painel de Resultado do Diagnóstico & Chat com Gemini
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1">
            <span>Padrão WEG / IEC / ANSI</span>
            <span aria-hidden="true">·</span>
            <span>Leitura Multimodal (/EL · /RB · /ME · /RM)</span>
            {attachments.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-sky-300">
                  {attachments.length} desenho(s) na cadeia ativa
                </span>
              </>
            )}
          </div>
        </div>

        {activeTurn && (
          <div className="flex flex-wrap items-center gap-2 no-print">
            {/* Status selector */}
            <select
              aria-label="Status da Falha"
              value={investigationStatus}
              onChange={(e) =>
                onUpdateStatus(e.target.value as InvestigationStatus)
              }
              className={`text-xs font-medium rounded-md px-2.5 py-1.5 border focus:outline-none cursor-pointer ${
                investigationStatus === 'resolvida'
                  ? 'bg-emerald-950/60 border-emerald-600/60 text-emerald-300'
                  : investigationStatus === 'aguardando_peca'
                  ? 'bg-amber-950/60 border-amber-600/60 text-amber-300'
                  : 'bg-slate-800 border-slate-700 text-slate-200'
              }`}
            >
              <option value="em_investigacao">Status: Em Investigação</option>
              <option value="resolvida">Status: Resolvida em Campo</option>
              <option value="aguardando_peca">Status: Aguardando Peça</option>
            </select>

            <button
              type="button"
              onClick={() => handleCopyMarkdown(activeTurn)}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              {copiedTurnId === activeTurn.id ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Laudo Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-400" />
                  <span>Copiar Laudo</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5 text-sky-400" />
              <span>Imprimir OS</span>
            </button>
          </div>
        )}
      </div>

      {/* Sequential Investigation Breadcrumb / Turn Switcher */}
      {turns.length > 1 && (
        <div className="px-6 py-2.5 bg-[#0B111E]/70 border-b border-slate-800 flex items-center gap-2 overflow-x-auto no-print">
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
                  className={`px-2.5 py-1 rounded text-xs font-mono tabular-nums transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
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
        <div className="m-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/70 text-rose-200 flex items-start gap-3">
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
                1. VARREDURA /EL & /RB
              </p>
              <p className="text-xs text-slate-300 mt-0.5">
                Localizando Folha, Página do PDF e Coordenada (Linha A–F, Coluna
                1–8)
              </p>
            </div>
            <div className="p-3 rounded border border-slate-800 bg-[#0B111E]/60 text-left">
              <p className="text-[11px] font-mono text-amber-400">
                2. PONTA DE PROVA & MANOBRA
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
                Pronto para Diagnóstico Eletromecânico e Chat Especialista
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Anexe o caderno de diagramas em PDF ou foto de campo na coluna à
                esquerda, digite o alarme sinalizado no supervisório (ou busque
                um histórico salvo acima) para abrir o laudo técnico e o chat em
                tempo real com o Gemini.
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
                  Chat Contínuo na Tela de Diagnóstico
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Após gerar o laudo, converse livremente com o Gemini sobre
                  medições feitas em campo ou peça análise de outras folhas do
                  PDF.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Populated Diagnostic Markdown Result + Interactive Chat */}
      {!isAnalyzing && activeTurn && (
        <div className="p-6 flex-1 flex flex-col gap-6">
          {/* Active Query Context Summary Box */}
          <div className="p-4 rounded-md bg-[#0B111E] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
                <Clock className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  {new Date(activeTurn.timestamp).toLocaleString('pt-BR')}
                </span>
                <span>·</span>
                <span>
                  Arquivos considerados:{' '}
                  {activeTurn.attachedFileNames.length > 0
                    ? activeTurn.attachedFileNames.join(', ')
                    : 'Consulta técnica direta'}
                </span>
              </div>
              <p className="text-sm font-semibold text-slate-100">
                Alarme / Consulta: "{activeTurn.userQuery}"
              </p>
            </div>

            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono shrink-0 no-print">
              <BookmarkCheck className="w-4 h-4" />
              <span>Salvo no Histórico</span>
            </div>
          </div>

          {/* Markdown Content with Industrial Styling */}
          <div className="prose prose-invert max-w-none text-sm leading-relaxed text-slate-200 space-y-4">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h3: ({ children }) => (
                  <h3 className="text-base font-bold text-slate-100 bg-slate-900/90 border border-slate-700/80 rounded-md px-4 py-2.5 mt-6 mb-3 tracking-tight">
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
                  <strong className="font-semibold text-white">
                    {children}
                  </strong>
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
              {activeTurn.markdownResponse}
            </ReactMarkdown>
          </div>

          {/* Alerta de Próximo PDF Necessário / Sequência de Desenhos */}
          <div className="p-4 rounded-lg bg-amber-950/30 border border-amber-700/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 no-print">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                <h4 className="text-xs font-semibold text-amber-200">
                  Continuidade de Sinal / Próximo Desenho na Sequência
                </h4>
              </div>
              <p className="text-xs text-amber-100/80 leading-relaxed">
                O sinal elétrico saiu pela régua de bornes para outro painel
                (ex: <code>PCPG1</code>, <code>PSE+CLP-SASE</code>,{' '}
                <code>QDCC</code>) ou requer uma folha complementar? Anexe o
                próximo PDF ou use o chat abaixo para aprofundar.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onOpenSequenceUpload}
                className="px-3.5 py-2 text-xs font-medium text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Adicionar Próximo Desenho na Sequência</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  onQuickFollowUp(
                    'Detalhe o rastreamento completo dos bornes de saída e informe qual folha ou documento externo deve ser verificado na sequência.'
                  )
                }
                className="px-3 py-2 text-xs font-medium text-amber-200 bg-amber-900/40 hover:bg-amber-900/60 border border-amber-700/50 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Detalhar Bornes de Saída
              </button>
            </div>
          </div>

          {/* Field Resolution Note Box (Saved in Fault History DB) */}
          <div className="p-4 rounded-lg bg-[#0B111E] border border-slate-800 flex flex-col gap-2.5 no-print">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="field-resolution-note"
                className="text-xs font-semibold text-slate-200 flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>
                  Registro de Resolução em Campo / Causa Raiz Confirmada (Salvo
                  no Histórico da Usina)
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

          {/* Interactive Gemini Chat Panel on the Active Fault */}
          <FaultChatPanel
            alarmTitle={activeTurn.userQuery}
            messages={activeTurn.chatMessages || []}
            onSendMessage={(text, attachment) =>
              onSendChatMessage(activeTurn.id, text, attachment)
            }
            onOpenSequenceUpload={onOpenSequenceUpload}
            isSending={isChatSending}
            chatProgressStep={chatProgressStep}
          />
        </div>
      )}
    </section>
  );
};
