import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare,
  Camera,
  Paperclip,
  FileText,
  Sparkles,
  FileSearch,
  Copy,
  Check,
  X,
  User,
  Bot,
  Plus,
  Library,
  Compass,
  Telescope,
  ArrowUp,
} from 'lucide-react';
import {
  ChatAttachmentPayload,
  DiagramCategoryTag,
  FaultChatMessage,
} from '../types';

interface FaultChatPanelProps {
  alarmTitle: string;
  messages: FaultChatMessage[];
  onSendMessage: (
    text: string,
    attachment?: ChatAttachmentPayload
  ) => Promise<void>;
  isSending: boolean;
  chatProgressStep?: string;
  onOpenSequenceUpload?: () => void;
}

const TACTICAL_CHAT_SUGGESTIONS = [
  'Analise detalhadamente a folha complementar citada na seção 5 do diagnóstico',
  'Medi 0 Vcc no borne indicado pelo guia. Qual o ponto a montante para testar agora?',
  'A tensão no borne está normal, mas o alarme persiste no supervisório. Como validar o cartão XED/CLP?',
  'Detalhe os terminais da bobina (A1-A2) e contatos NA/NF deste circuito na folha funcional',
  'Gere um resumo executivo desta falha e da solução para registro na Ordem de Serviço (OS)',
];

function inferCategoryFromFilename(filename: string): DiagramCategoryTag {
  const upper = filename.toUpperCase();
  if (upper.includes('RB') || upper.includes('BORNE')) return '/RB';
  if (upper.includes('ME') || upper.includes('MECANIC')) return '/ME';
  if (
    upper.includes('RM') ||
    upper.includes('MATERIA') ||
    upper.includes('LISTA')
  )
    return '/RM';
  if (
    upper.endsWith('.JPG') ||
    upper.endsWith('.JPEG') ||
    upper.endsWith('.PNG') ||
    upper.endsWith('.WEBP')
  ) {
    return 'FOTO CAMPO';
  }
  return '/EL';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export const FaultChatPanel: React.FC<FaultChatPanelProps> = ({
  alarmTitle,
  messages,
  onSendMessage,
  isSending,
  chatProgressStep,
  onOpenSequenceUpload,
}) => {
  const [inputText, setInputText] = useState('');
  const [attachedFile, setAttachedFile] =
    useState<ChatAttachmentPayload | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [fileAcceptMode, setFileAcceptMode] = useState<string>(
    '.pdf,application/pdf,image/jpeg,image/png,image/webp'
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        plusMenuRef.current &&
        !plusMenuRef.current.contains(event.target as Node)
      ) {
        setIsPlusMenuOpen(false);
      }
    };
    if (isPlusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPlusMenuOpen]);

  const triggerFilePicker = (accept: string) => {
    setFileAcceptMode(accept);
    setIsPlusMenuOpen(false);
    setTimeout(() => {
      fileInputRef.current?.click();
    }, 20);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await fileToBase64(file);
      const isPdf =
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf');
      const mimeType = isPdf ? 'application/pdf' : file.type || 'image/jpeg';
      const defaultCategory = inferCategoryFromFilename(file.name);

      setAttachedFile({
        base64,
        mimeType,
        name: file.name,
        sizeBytes: file.size,
        categoryTag: defaultCategory,
        panelName: '',
      });
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    } catch {
      // Ignore file error
    }
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending || (!inputText.trim() && !attachedFile)) return;

    const isPdf = attachedFile?.mimeType === 'application/pdf';
    const defaultPrompt = isPdf
      ? `Anexei o novo caderno PDF "${attachedFile?.name}"${
          attachedFile?.panelName ? ` (Painel ${attachedFile.panelName})` : ''
        } para continuarmos a investigação desta falha. Analise este diagrama em conjunto com o contexto atual.`
      : 'Analise esta foto de medição/campo em relação à falha atual.';

    const textToSend = inputText.trim() || defaultPrompt;
    const fileToSend = attachedFile || undefined;

    setInputText('');
    setAttachedFile(null);
    setIsPlusMenuOpen(false);

    await onSendMessage(textToSend, fileToSend);
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  const handleSuggestionClick = async (suggestion: string) => {
    if (isSending) return;
    await onSendMessage(suggestion);
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  const handleCopy = async (msg: FaultChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="mt-6 border border-sky-500/30 rounded-lg bg-[#0B111E] flex flex-col no-print">
      {/* Header */}
      <div className="px-5 py-3.5 bg-slate-900/90 border-b border-slate-800 rounded-t-lg flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <span>
                Chat Técnico Interativo com Especialista Gemini (Tempo Real)
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Continue perguntando sobre{' '}
              <span className="text-sky-300 font-medium">"{alarmTitle}"</span>{' '}
              ou clique no botão <strong>+</strong> abaixo para adicionar fotos e
              novos PDFs (ex: <code>CLP-SASE</code>, <code>QDCC</code>)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {messages.length}{' '}
            {messages.length === 1 ? 'interação' : 'interações'}
          </span>
        </div>
      </div>

      {/* Tactical 1-Click Field Suggestions */}
      <div className="px-5 py-3 bg-[#111827]/70 border-b border-slate-800/80 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
          <Sparkles className="w-3.5 h-3.5" />
          <span>
            Perguntas Rápidas de Bancada e Campo (clique para enviar):
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TACTICAL_CHAT_SUGGESTIONS.map((sug) => (
            <button
              key={sug}
              type="button"
              disabled={isSending}
              onClick={() => handleSuggestionClick(sug)}
              className="text-left text-xs text-slate-300 hover:text-sky-200 bg-[#0B111E] hover:bg-sky-500/15 border border-slate-800 hover:border-sky-500/40 rounded-md px-2.5 py-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              {sug}
            </button>
          ))}
        </div>
      </div>

      {/* Conversation History Stream */}
      <div className="p-5 flex flex-col gap-4 max-h-[540px] overflow-y-auto">
        {messages.length === 0 && !isSending ? (
          <div className="py-6 text-center space-y-2">
            <p className="text-xs text-slate-300 font-medium">
              Tem alguma dúvida específica sobre um borne, relé, folha complementar ou resultado do multímetro?
            </p>
            <p className="text-xs text-slate-400 max-w-xl mx-auto">
              Use o botão <strong>+</strong> na barra abaixo para anexar um novo
              PDF elétrico ou foto tirada em campo, ou digite sua pergunta
              diretamente.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                className={`flex flex-col gap-1.5 ${
                  isUser ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-3xl w-full rounded-lg p-4 border ${
                    isUser
                      ? 'bg-sky-950/30 border-sky-800/60 text-slate-100 ml-auto sm:w-auto sm:min-w-[320px]'
                      : 'bg-[#111827] border-slate-800 text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-2 mb-2.5 text-xs text-slate-400">
                    <div className="flex items-center gap-1.5 font-medium">
                      {isUser ? (
                        <>
                          <User className="w-3.5 h-3.5 text-sky-400" />
                          <span className="text-sky-300">
                            Operador / Manutenção
                          </span>
                        </>
                      ) : (
                        <>
                          <Bot className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-300">
                            Engenheiro Especialista HydroDiag AI
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 font-mono tabular-nums text-[11px]">
                      <span>
                        {new Date(msg.timestamp).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {!isUser && (
                        <button
                          type="button"
                          onClick={() => handleCopy(msg)}
                          className="text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
                          title="Copiar resposta"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {msg.attachedImageName && (
                    <div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs font-mono text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-1.5">
                      {msg.attachedImageName.toLowerCase().endsWith('.pdf') ? (
                        <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <Camera className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      )}
                      <span>Arquivo anexado no chat: {msg.attachedImageName}</span>
                      {msg.attachedFileCategory && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px]">
                          {msg.attachedFileCategory}
                        </span>
                      )}
                      {msg.attachedPanelName && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[10px]">
                          Painel: {msg.attachedPanelName}
                        </span>
                      )}
                    </div>
                  )}

                  {isUser ? (
                    <p className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                      {msg.content}
                    </p>
                  ) : (
                    <div className="prose prose-invert max-w-none text-sm leading-relaxed space-y-2.5">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h3: ({ children }) => (
                            <h4 className="text-sm font-bold text-slate-100 bg-slate-900 border border-slate-700/80 rounded px-3 py-1.5 mt-3 mb-2">
                              {children}
                            </h4>
                          ),
                          h4: ({ children }) => (
                            <h5 className="text-xs font-semibold text-sky-300 mt-3 mb-1">
                              {children}
                            </h5>
                          ),
                          p: ({ children }) => (
                            <p className="text-sm text-slate-200 leading-relaxed mb-2">
                              {children}
                            </p>
                          ),
                          ul: ({ children }) => (
                            <ul className="list-disc pl-5 space-y-1 text-sm text-slate-200 mb-2">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }) => (
                            <ol className="list-decimal pl-5 space-y-1 text-sm text-slate-200 mb-2">
                              {children}
                            </ol>
                          ),
                          code: ({ children }) => (
                            <code className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-sky-300 font-mono text-xs tabular-nums">
                              {children}
                            </code>
                          ),
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  )}

                  {!isUser &&
                    msg.inspectedPages &&
                    msg.inspectedPages.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-slate-800/80 text-[11px] font-mono tabular-nums text-slate-400">
                        Páginas do PDF inspecionadas nesta resposta:{' '}
                        {msg.inspectedPages.join(', ')}
                      </div>
                    )}
                </div>
              </div>
            );
          })
        )}

        {isSending && (
          <div className="p-4 rounded-lg bg-[#111827] border border-sky-500/30 flex items-center gap-3">
            <FileSearch className="w-5 h-5 text-sky-400 animate-spin shrink-0" />
            <div className="text-xs">
              <p className="font-semibold text-slate-100">
                {chatProgressStep ||
                  'Consultando folhas do diagrama e analisando resposta...'}
              </p>
              <p className="text-slate-400 mt-0.5">
                Rastreando bornes, referências cruzadas e histórico da falha...
              </p>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* GPT-Style Composer Form */}
      <form
        onSubmit={handleSubmit}
        className="p-4 bg-slate-900/90 border-t border-slate-800 rounded-b-lg"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={fileAcceptMode}
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Unified Pill/Rounded Container */}
        <div className="relative bg-[#161F30] border border-slate-700/90 focus-within:border-sky-500/80 rounded-3xl px-3.5 py-2.5 shadow-inner transition-colors flex flex-col gap-2.5">
          {/* Attached File Preview Chip inside Composer */}
          {attachedFile && (
            <div className="flex flex-col gap-2 bg-[#0B111E]/90 border border-sky-500/40 rounded-2xl p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
                    {attachedFile.mimeType === 'application/pdf' ? (
                      <FileText className="w-4 h-4 text-sky-400" />
                    ) : (
                      <Camera className="w-4 h-4 text-amber-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-slate-100 truncate">
                      {attachedFile.name}
                    </div>
                    <div className="text-[11px] text-slate-400 flex items-center gap-2">
                      <span>
                        {attachedFile.mimeType === 'application/pdf'
                          ? 'Documento PDF Técnico'
                          : 'Imagem / Foto de Campo'}
                      </span>
                      {attachedFile.sizeBytes && (
                        <span className="font-mono">
                          • {(attachedFile.sizeBytes / (1024 * 1024)).toFixed(2)}{' '}
                          MB
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setAttachedFile(null)}
                  className="text-slate-400 hover:text-white p-1.5 rounded-full hover:bg-slate-800 cursor-pointer shrink-0"
                  title="Remover arquivo"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {attachedFile.mimeType === 'application/pdf' && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                  <span className="text-[11px] text-sky-300 font-medium">
                    Classificação na sequência:
                  </span>
                  <select
                    aria-label="Categoria do PDF anexado no chat"
                    value={attachedFile.categoryTag || '/EL'}
                    onChange={(e) =>
                      setAttachedFile((prev) =>
                        prev
                          ? {
                              ...prev,
                              categoryTag: e.target.value as DiagramCategoryTag,
                            }
                          : null
                      )
                    }
                    className="bg-[#161F30] border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  >
                    <option value="/EL">/EL (Esquema Elétrico)</option>
                    <option value="/RB">/RB (Régua de Bornes)</option>
                    <option value="/ME">/ME (Desenho Mecânico)</option>
                    <option value="/RM">/RM (Relação de Materiais)</option>
                  </select>

                  <input
                    type="text"
                    value={attachedFile.panelName || ''}
                    onChange={(e) =>
                      setAttachedFile((prev) =>
                        prev ? { ...prev, panelName: e.target.value } : null
                      )
                    }
                    placeholder="Painel (ex: CLP-SASE, QDCC, PCPG1)"
                    className="bg-[#161F30] border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500 flex-1 min-w-[200px]"
                  />
                </div>
              )}
            </div>
          )}

          {/* Main Row: (+) Button + Input + Send Button */}
          <div className="flex items-center gap-2.5">
            {/* Plus Button & Popover Container */}
            <div ref={plusMenuRef} className="relative shrink-0">
              <button
                type="button"
                disabled={isSending}
                onClick={() => setIsPlusMenuOpen((prev) => !prev)}
                title="Adicionar fotos, PDFs ou ferramentas"
                aria-label="Abrir menu de anexos e ferramentas"
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-all cursor-pointer disabled:opacity-50 ${
                  isPlusMenuOpen
                    ? 'bg-slate-700 text-white ring-2 ring-sky-500/50'
                    : 'bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700'
                }`}
              >
                <Plus
                  className={`w-5 h-5 transition-transform duration-200 ${
                    isPlusMenuOpen ? 'rotate-45' : ''
                  }`}
                />
              </button>

              {/* Floating GPT-Style Popover Menu */}
              {isPlusMenuOpen && (
                <div className="absolute bottom-full left-0 mb-3 w-80 sm:w-96 rounded-2xl bg-[#1A2234] border border-slate-700/90 shadow-2xl p-2 z-50 flex flex-col gap-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <button
                    type="button"
                    onClick={() =>
                      triggerFilePicker(
                        '.pdf,application/pdf,image/jpeg,image/png,image/webp'
                      )
                    }
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                  >
                    <Paperclip className="w-4 h-4 text-slate-200 group-hover:text-sky-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-slate-100">
                        Adicionar fotos e arquivos
                      </span>
                      <span className="text-xs text-slate-400">
                        Enviar do computador
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => triggerFilePicker('.pdf,application/pdf')}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                  >
                    <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-slate-100">
                        Anexar caderno PDF
                      </span>
                      <span className="text-xs text-slate-400">
                        Painel CLP-SASE, QDCC, /EL, /RB
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      triggerFilePicker('image/jpeg,image/png,image/webp')
                    }
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                  >
                    <Camera className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-slate-100">
                        Foto de medição / painel
                      </span>
                      <span className="text-xs text-slate-400">
                        Multímetro, bornes ou cartão CLP
                      </span>
                    </div>
                  </button>

                  {onOpenSequenceUpload && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlusMenuOpen(false);
                        onOpenSequenceUpload();
                      }}
                      className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                    >
                      <Library className="w-4 h-4 text-emerald-400 shrink-0" />
                      <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                        <span className="text-xs sm:text-sm font-semibold text-slate-100">
                          Adicionar da biblioteca
                        </span>
                        <span className="text-xs text-slate-400">
                          Gerenciar sequência de desenhos
                        </span>
                      </div>
                    </button>
                  )}

                  <div className="my-1 border-t border-slate-800" />

                  <button
                    type="button"
                    onClick={() => {
                      setIsPlusMenuOpen(false);
                      setInputText(
                        'Rastreie a interligação de bornes e folhas complementares entre os painéis para localizar o componente exato: '
                      );
                      setTimeout(() => textareaRef.current?.focus(), 40);
                    }}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                  >
                    <Compass className="w-4 h-4 text-sky-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-slate-100">
                        Rastreamento cruzado
                      </span>
                      <span className="text-xs text-slate-400">
                        Seguir bornes entre painéis
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsPlusMenuOpen(false);
                      setInputText(
                        'Faça uma pesquisa aprofundada em todas as páginas inspecionadas e monte um relatório detalhado de causa raiz e testes: '
                      );
                      setTimeout(() => textareaRef.current?.focus(), 40);
                    }}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-slate-800/90 text-left transition-colors cursor-pointer group"
                  >
                    <Telescope className="w-4 h-4 text-indigo-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-slate-100">
                        Pesquisa aprofundada
                      </span>
                      <span className="text-xs text-slate-400">
                        Obtenha um relatório detalhado
                      </span>
                    </div>
                  </button>
                </div>
              )}
            </div>

            {/* Auto-growing / Clean Textarea */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Pergunte qualquer coisa ou clique no + para anexar PDFs e fotos..."
              className="flex-1 bg-transparent border-0 px-1 py-1.5 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none resize-none max-h-32 overflow-y-auto leading-relaxed"
            />

            {/* Circular Send Button */}
            <button
              type="submit"
              disabled={isSending || (!inputText.trim() && !attachedFile)}
              title="Enviar mensagem"
              aria-label="Enviar mensagem"
              className="w-9 h-9 rounded-full bg-sky-500 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold transition-all flex items-center justify-center cursor-pointer shrink-0 shadow-sm"
            >
              <ArrowUp className="w-5 h-5 stroke-[2.5]" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

