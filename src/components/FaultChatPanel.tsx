import React, { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare,
  Send,
  Camera,
  Sparkles,
  FileSearch,
  Copy,
  Check,
  X,
  User,
  Bot,
} from 'lucide-react';
import { FaultChatMessage } from '../types';

interface FaultChatPanelProps {
  alarmTitle: string;
  messages: FaultChatMessage[];
  onSendMessage: (
    text: string,
    inlineImage?: { base64: string; mimeType: string; name: string }
  ) => Promise<void>;
  isSending: boolean;
  chatProgressStep?: string;
}

const TACTICAL_CHAT_SUGGESTIONS = [
  'Analise detalhadamente a folha complementar citada na seção 5 do diagnóstico',
  'Medi 0 Vcc no borne indicado pelo guia. Qual o ponto a montante para testar agora?',
  'A tensão no borne está normal, mas o alarme persiste no supervisório. Como validar o cartão XED/CLP?',
  'Detalhe os terminais da bobina (A1-A2) e contatos NA/NF deste circuito na folha funcional',
  'Gere um resumo executivo desta falha e da solução para registro na Ordem de Serviço (OS)',
];

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
}) => {
  const [inputText, setInputText] = useState('');
  const [attachedPhoto, setAttachedPhoto] = useState<{
    base64: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await fileToBase64(file);
      setAttachedPhoto({
        base64,
        mimeType: file.type || 'image/jpeg',
        name: file.name,
      });
    } catch {
      // Ignore file error
    }
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending || (!inputText.trim() && !attachedPhoto)) return;

    const textToSend =
      inputText.trim() ||
      'Analise esta foto de medição/campo em relação à falha atual.';
    const photoToSend = attachedPhoto || undefined;

    setInputText('');
    setAttachedPhoto(null);

    await onSendMessage(textToSend, photoToSend);
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
    <div className="mt-6 border border-sky-500/30 rounded-lg bg-[#0B111E] overflow-hidden flex flex-col no-print">
      {/* Header */}
      <div className="px-5 py-3.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
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
              <span className="text-sky-300 font-medium">"{alarmTitle}"</span> —
              a IA consulta automaticamente qualquer folha do PDF anexado
            </p>
          </div>
        </div>

        <span className="text-xs font-mono tabular-nums text-slate-400">
          {messages.length} {messages.length === 1 ? 'interação' : 'interações'}
        </span>
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
              Digite sua pergunta abaixo ou envie uma foto tirada em campo (ex:
              leitura do multímetro, estado dos LEDs do CLP ou régua de bornes)
              para continuar a investigação passo a passo.
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
                    <div className="mb-2 text-xs font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1 inline-block">
                      Foto anexada: {msg.attachedImageName}
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

      {/* Chat Input Form */}
      <form
        onSubmit={handleSubmit}
        className="p-4 bg-slate-900/90 border-t border-slate-800 flex flex-col gap-2.5"
      >
        {attachedPhoto && (
          <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-1.5 text-xs text-amber-200">
            <span className="font-mono truncate">
              Foto de campo anexada: {attachedPhoto.name}
            </span>
            <button
              type="button"
              onClick={() => setAttachedPhoto(null)}
              className="text-amber-300 hover:text-white p-0.5 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handlePhotoChange}
            className="hidden"
          />

          <button
            type="button"
            disabled={isSending}
            onClick={() => fileInputRef.current?.click()}
            title="Anexar foto do multímetro ou painel no chat"
            className="p-2.5 text-slate-300 hover:text-sky-300 bg-[#0B111E] hover:bg-slate-800 border border-slate-700 rounded-md transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          >
            <Camera className="w-4 h-4" />
          </button>

          <textarea
            rows={2}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder='Pergunte ao Gemini sobre a falha (ex: "Analise a Folha 27 e a Folha 31", "Medi 0Vcc no borne XED:217, onde testo agora?")...'
            className="flex-1 bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-md px-3 py-2 text-xs sm:text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none resize-none"
          />

          <button
            type="submit"
            disabled={isSending || (!inputText.trim() && !attachedPhoto)}
            className="px-4 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Enviar no Chat</span>
          </button>
        </div>
      </form>
    </div>
  );
};
