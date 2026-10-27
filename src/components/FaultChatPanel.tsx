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
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
} from 'lucide-react';
import {
  ChatAttachmentPayload,
  DiagramCategoryTag,
  FaultChatMessage,
} from '../types';
import {
  formatTechnicalSymbols,
  linkifyPdfPageReferences,
} from '../utils/pdfClientEngine';

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
  onOpenPdfDeepLink?: (pageNumber: number) => void;
  fillHeight?: boolean;
}

const TACTICAL_CHAT_SUGGESTIONS = [
  'Monte uma árvore de decisão passo a passo para isolar este defeito sem risco de Trip (86/52G) na Unidade Geradora',
  'Medi 0 Vcc no borne indicado. Qual a sua decisão técnica sobre o trecho a montante e qual borne medir agora?',
  'Como testar e isolar possível fuga à terra ou curto à massa neste circuito de comando 125 Vcc / 24 Vcc?',
  'A tensão chega no borne, mas o supervisório não atua. Como validar o cartão XED/CLP e o relé auxiliar (A1-A2)?',
  'Analise a interligação entre o painel atual e os serviços auxiliares (QDCC/QDSA/UHLM) e indique a manobra segura',
  'Emita o parecer técnico de Engenharia Elétrica com causa raiz e solução para fechamento da Ordem de Serviço (OS)',
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

async function normalizeImageForChat(file: File): Promise<{
  base64: string;
  mimeType: string;
  previewDataUrl: string;
}> {
  const rawBase64 = await fileToBase64(file);
  const rawMime = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
  const rawDataUrl = `data:${rawMime};base64,${rawBase64}`;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 1600;
        let width = img.naturalWidth || img.width || 1200;
        let height = img.naturalHeight || img.height || 900;

        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({
            base64: rawBase64,
            mimeType: rawMime,
            previewDataUrl: rawDataUrl,
          });
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.86);
        const compressedBase64 = compressedDataUrl.includes(',')
          ? compressedDataUrl.split(',')[1]
          : rawBase64;
        resolve({
          base64: compressedBase64,
          mimeType: 'image/jpeg',
          previewDataUrl: compressedDataUrl,
        });
      } catch {
        resolve({
          base64: rawBase64,
          mimeType: rawMime,
          previewDataUrl: rawDataUrl,
        });
      }
    };
    img.onerror = () => {
      resolve({
        base64: rawBase64,
        mimeType: rawMime,
        previewDataUrl: rawDataUrl,
      });
    };
    img.src = rawDataUrl;
  });
}

export const FaultChatPanel: React.FC<FaultChatPanelProps> = ({
  alarmTitle,
  messages,
  onSendMessage,
  isSending,
  chatProgressStep,
  onOpenSequenceUpload,
  onOpenPdfDeepLink,
  fillHeight = false,
}) => {
  const [inputText, setInputText] = useState('');
  const [attachedFile, setAttachedFile] =
    useState<ChatAttachmentPayload | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(
    () => messages.length === 0
  );
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState(false);
  const [voiceStatusText, setVoiceStatusText] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const speechRecRef = useRef<{ stop: () => void; abort?: () => void } | null>(
    null
  );
  const keepListeningRef = useRef<boolean>(false);
  const restartTimerRef = useRef<number | null>(null);
  const baseTextBeforeMicRef = useRef<string>('');
  const completedSessionsTextRef = useRef<string>('');
  const currentSessionFinalRef = useRef<string>('');
  const currentSessionInterimRef = useRef<string>('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const stopMediaStream = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  };

  const stopVoiceDictation = () => {
    keepListeningRef.current = false;
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (speechRecRef.current) {
      try {
        speechRecRef.current.stop();
      } catch {
        // Ignore
      }
      speechRecRef.current = null;
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        stopMediaStream();
      }
    } else {
      stopMediaStream();
    }
    setIsListeningVoice(false);
    setVoiceStatusText(null);
  };

  useEffect(() => {
    return () => {
      keepListeningRef.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      try {
        speechRecRef.current?.stop();
      } catch {
        // Ignore
      }
      stopMediaStream();
    };
  }, []);

  const toggleChatVoiceDictation = async () => {
    if (isListeningVoice) {
      stopVoiceDictation();
      setTimeout(() => textareaRef.current?.focus(), 30);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        maxAlternatives?: number;
        onresult: (event: {
          resultIndex?: number;
          results: ArrayLike<{ isFinal?: boolean; 0: { transcript: string } }>;
        }) => void;
        onerror: (event: { error?: string }) => void;
        onend: () => void;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        maxAlternatives?: number;
        onresult: (event: {
          resultIndex?: number;
          results: ArrayLike<{ isFinal?: boolean; 0: { transcript: string } }>;
        }) => void;
        onerror: (event: { error?: string }) => void;
        onend: () => void;
        start: () => void;
        stop: () => void;
      };
    };

    const SpeechRecClass =
      win.SpeechRecognition || win.webkitSpeechRecognition;

    baseTextBeforeMicRef.current = inputText.trim();
    completedSessionsTextRef.current = '';
    currentSessionFinalRef.current = '';
    currentSessionInterimRef.current = '';
    keepListeningRef.current = true;
    setIsListeningVoice(true);
    setVoiceStatusText(
      '🎙️ Microfone contínuo ativo (sem limite de tempo) — Fale à vontade e clique em Concluir quando terminar...'
    );

    if (SpeechRecClass) {
      const startRecognitionInstance = () => {
        if (!keepListeningRef.current) return;
        try {
          const rec = new SpeechRecClass();
          rec.lang = 'pt-BR';
          rec.continuous = true;
          rec.interimResults = true;
          rec.maxAlternatives = 1;

          rec.onresult = (event) => {
            if (!keepListeningRef.current) return;
            const finalParts: string[] = [];
            const interimParts: string[] = [];

            for (let i = 0; i < event.results.length; i++) {
              const res = event.results[i];
              const transcript = (res?.[0]?.transcript || '').trim();
              if (!transcript) continue;
              if (res?.isFinal) {
                finalParts.push(transcript);
              } else {
                interimParts.push(transcript);
              }
            }

            currentSessionFinalRef.current = finalParts.join(' ').trim();
            currentSessionInterimRef.current = interimParts.join(' ').trim();

            const fullText = [
              baseTextBeforeMicRef.current,
              completedSessionsTextRef.current,
              currentSessionFinalRef.current,
              currentSessionInterimRef.current,
            ]
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();

            setInputText(fullText);

            if (currentSessionInterimRef.current) {
              setVoiceStatusText(
                `🎙️ Capturando contínuo: "${currentSessionInterimRef.current}"`
              );
            } else {
              setVoiceStatusText(
                '🎙️ Microfone contínuo ativo — Pode continuar falando (sem limite de tempo)...'
              );
            }
          };

          rec.onerror = (event) => {
            const errCode = event?.error || '';
            if (
              errCode === 'not-allowed' ||
              errCode === 'service-not-allowed' ||
              errCode === 'audio-capture'
            ) {
              keepListeningRef.current = false;
              setIsListeningVoice(false);
              setVoiceStatusText(
                '⚠️ Permita o acesso ao microfone no navegador para usar o ditado por voz.'
              );
              setTimeout(() => setVoiceStatusText(null), 4000);
            }
            // For 'no-speech', 'network', or 'aborted' during pauses, onend will automatically restart
          };

          rec.onend = () => {
            // Preserve whatever was spoken in this cycle before restarting
            const cycleText = [
              currentSessionFinalRef.current,
              currentSessionInterimRef.current,
            ]
              .filter(Boolean)
              .join(' ')
              .trim();

            if (cycleText) {
              completedSessionsTextRef.current = [
                completedSessionsTextRef.current,
                cycleText,
              ]
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
              currentSessionFinalRef.current = '';
              currentSessionInterimRef.current = '';
            }

            if (keepListeningRef.current) {
              restartTimerRef.current = window.setTimeout(() => {
                startRecognitionInstance();
              }, 60);
            } else {
              setIsListeningVoice(false);
              setVoiceStatusText(null);
            }
          };

          speechRecRef.current = rec;
          rec.start();
        } catch {
          if (keepListeningRef.current) {
            restartTimerRef.current = window.setTimeout(() => {
              startRecognitionInstance();
            }, 250);
          }
        }
      };

      startRecognitionInstance();
      return;
    }

    // Fallback for browsers without Web Speech API (e.g. Firefox Desktop)
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        mediaStreamRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        const chunks: BlobPart[] = [];

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            chunks.push(ev.data);
          }
        };

        recorder.onstop = async () => {
          stopMediaStream();
          if (chunks.length === 0) {
            setVoiceStatusText(null);
            setIsListeningVoice(false);
            return;
          }

          const blob = new Blob(chunks, {
            type: recorder.mimeType || 'audio/webm',
          });
          if (blob.size < 800) {
            setVoiceStatusText(null);
            setIsListeningVoice(false);
            return;
          }

          setIsTranscribingAudio(true);
          setVoiceStatusText('⏳ Transcrevendo áudio técnico (pt-BR)...');
          try {
            const base64Audio = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const res = String(reader.result || '');
                const commaIdx = res.indexOf(',');
                resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });

            const resp = await fetch('/api/serverless-step', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'transcribe_audio',
                audioBase64: base64Audio,
                mimeType: blob.type || 'audio/webm',
              }),
            });
            if (resp.ok) {
              const data = (await resp.json()) as { transcript?: string };
              const text = (data.transcript || '').trim();
              if (text) {
                setInputText((prev) =>
                  prev.trim() ? `${prev.trim()} ${text}` : text
                );
                setTimeout(() => textareaRef.current?.focus(), 30);
              }
            }
          } catch {
            // Ignore transcription fallback errors
          } finally {
            setIsTranscribingAudio(false);
            setVoiceStatusText(null);
            setIsListeningVoice(false);
          }
        };

        mediaRecorderRef.current = recorder;
        recorder.start(1000);
      } catch {
        keepListeningRef.current = false;
        setIsListeningVoice(false);
        setVoiceStatusText(
          '⚠️ Permita o acesso ao microfone no navegador para usar o ditado por voz.'
        );
        setTimeout(() => setVoiceStatusText(null), 4000);
      }
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        plusMenuRef.current &&
        !plusMenuRef.current.contains(event.target as Node)
      ) {
        setIsPlusMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        setIsPlusMenuOpen(false);
      }
    };
    if (isPlusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('keydown', handleKeyDown, true);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isPlusMenuOpen]);

  const processSelectedFile = async (file: File) => {
    try {
      const isPdf =
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        const base64 = await fileToBase64(file);
        const defaultCategory = inferCategoryFromFilename(file.name);
        setAttachedFile({
          base64,
          mimeType: 'application/pdf',
          name: file.name || 'desenho_anexado.pdf',
          sizeBytes: file.size,
          categoryTag: defaultCategory,
          panelName: '',
        });
      } else {
        const { base64, mimeType, previewDataUrl } =
          await normalizeImageForChat(file);
        setAttachedFile({
          base64,
          mimeType,
          name: file.name || `foto_campo_${Date.now()}.jpg`,
          sizeBytes: file.size,
          categoryTag: 'FOTO CAMPO',
          panelName: '',
          previewDataUrl,
        });
      }
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 40);
    } catch {
      // Ignore file read error
    }
  };

  const triggerFilePicker = (accept: string) => {
    setIsPlusMenuOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processSelectedFile(file);
    e.target.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          await processSelectedFile(file);
          return;
        }
      }
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await processSelectedFile(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending || (!inputText.trim() && !attachedFile)) return;

    if (isListeningVoice || keepListeningRef.current) {
      stopVoiceDictation();
    }

    const isPdf = attachedFile?.mimeType === 'application/pdf';
    const defaultPrompt = isPdf
      ? `Anexei o novo caderno PDF "${attachedFile?.name}"${
          attachedFile?.panelName ? ` (Painel ${attachedFile.panelName})` : ''
        } para continuarmos a investigação desta falha. Analise este diagrama em conjunto com o contexto atual.`
      : 'Analise esta foto de medição/campo anexada em relação à falha atual.';

    const textToSend = inputText.trim() || defaultPrompt;
    const fileToSend = attachedFile || undefined;

    setInputText('');
    baseTextBeforeMicRef.current = '';
    completedSessionsTextRef.current = '';
    currentSessionFinalRef.current = '';
    currentSessionInterimRef.current = '';
    setAttachedFile(null);
    setIsPlusMenuOpen(false);

    await onSendMessage(textToSend, fileToSend);
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  const handleSuggestionClick = async (suggestion: string) => {
    if (isSending) return;
    const fileToSend = attachedFile || undefined;
    setAttachedFile(null);
    setShowSuggestions(false);
    await onSendMessage(suggestion, fileToSend);
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  const handleCopy = async (msg: FaultChatMessage) => {
    try {
      await navigator.clipboard.writeText(formatTechnicalSymbols(msg.content));
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <div
      className={`bg-[#0B111E] flex flex-col no-print ${
        fillHeight
          ? 'h-full min-h-0 flex-1'
          : 'mt-4 border border-sky-500/30 rounded-lg'
      }`}
    >
      {/* Header */}
      <div
        className={`px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0 ${
          fillHeight ? '' : 'rounded-t-lg'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-md bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs sm:text-sm font-semibold text-slate-100 truncate">
              Eng. Eletricista Sênior — Chat Técnico em Tempo Real
            </h3>
            <p className="text-[11px] text-slate-400 truncate">
              Alarme:{' '}
              <span className="text-sky-300 font-medium">
                &quot;{alarmTitle}&quot;
              </span>{' '}
              · Botão <strong>+</strong> anexa PDF ou Foto
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowSuggestions((prev) => !prev)}
            className="px-2.5 py-1 rounded text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 flex items-center gap-1 cursor-pointer transition-colors"
          >
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span>Perguntas Rápidas</span>
            {showSuggestions ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>

          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            {messages.length} msg
          </span>
        </div>
      </div>

      {/* Collapsible Tactical 1-Click Field Suggestions */}
      {showSuggestions && (
        <div className="px-4 py-2.5 bg-[#111827]/80 border-b border-slate-800/80 flex flex-col gap-1.5 shrink-0">
          <div className="flex items-center justify-between text-[11px] font-medium text-sky-300">
            <span>
              Perguntas Rápidas de Bancada e Campo (clique para enviar):
            </span>
            <button
              type="button"
              onClick={() => setShowSuggestions(false)}
              className="text-slate-400 hover:text-slate-200 text-[10px] cursor-pointer"
            >
              Ocultar
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-36 overflow-y-auto pr-1">
            {TACTICAL_CHAT_SUGGESTIONS.map((sug) => (
              <button
                key={sug}
                type="button"
                disabled={isSending}
                onClick={() => handleSuggestionClick(sug)}
                className="text-left text-[11px] text-slate-300 hover:text-sky-200 bg-[#0B111E] hover:bg-sky-500/15 border border-slate-800 hover:border-sky-500/40 rounded px-2.5 py-1.5 transition-colors cursor-pointer disabled:opacity-50 line-clamp-2"
              >
                {sug}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conversation History Stream */}
      <div
        className={`p-4 flex flex-col gap-4 overflow-y-auto ${
          fillHeight ? 'flex-1 min-h-0' : 'max-h-[520px]'
        }`}
      >
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
                            Eng. Eletricista Sênior (PCH/UHE)
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
                    <div className="mb-2.5 flex flex-col gap-2 text-xs font-mono text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {msg.attachedImageName.toLowerCase().endsWith('.pdf') ? (
                          <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <Camera className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        )}
                        <span>Arquivo enviado: {msg.attachedImageName}</span>
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
                      {msg.attachedPreviewDataUrl && (
                        <img
                          src={msg.attachedPreviewDataUrl}
                          alt={msg.attachedImageName}
                          className="max-h-44 w-auto rounded border border-slate-700 object-contain self-start bg-slate-950"
                        />
                      )}
                    </div>
                  )}

                  {isUser ? (
                    <p className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                      {formatTechnicalSymbols(msg.content)}
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
                          a: ({ href, children }) => {
                            if (href && href.startsWith('#pdf-page-')) {
                              const pageNum = parseInt(
                                href.replace('#pdf-page-', ''),
                                10
                              );
                              return (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (onOpenPdfDeepLink && !isNaN(pageNum)) {
                                      onOpenPdfDeepLink(pageNum);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-sky-500/15 hover:bg-sky-500/30 border border-sky-500/40 text-sky-300 font-mono text-xs tabular-nums transition-colors cursor-pointer align-baseline"
                                  title={`Abrir Inspetor Deep-Link na Página ${pageNum} do PDF`}
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
                        }}
                      >
                        {linkifyPdfPageReferences(
                          formatTechnicalSymbols(msg.content)
                        )}
                      </ReactMarkdown>
                    </div>
                  )}

                  {!isUser &&
                    msg.inspectedPages &&
                    msg.inspectedPages.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums text-slate-400">
                        <span>Páginas inspecionadas (clique para abrir):</span>
                        {msg.inspectedPages.map((pg) => (
                          <button
                            key={pg}
                            type="button"
                            onClick={() =>
                              onOpenPdfDeepLink && onOpenPdfDeepLink(pg)
                            }
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-sky-500/20 border border-slate-700 hover:border-sky-500/40 text-sky-300 transition-colors cursor-pointer flex items-center gap-1"
                            title={`Abrir Página ${pg} do PDF no Inspetor Interativo`}
                          >
                            <FileText className="w-3 h-3 text-sky-400" />
                            <span>Pág. {pg}</span>
                          </button>
                        ))}
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
          accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/*"
          onChange={handleFileChange}
          className="hidden"
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Unified Pill/Rounded Container */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={handleDrop}
          className={`relative bg-[#161F30] border rounded-3xl px-3.5 py-2.5 shadow-inner transition-colors flex flex-col gap-2.5 ${
            isDraggingOver
              ? 'border-sky-400 bg-sky-950/30'
              : 'border-slate-700/90 focus-within:border-sky-500/80'
          }`}
        >
          {/* Attached File Preview Chip inside Composer */}
          {attachedFile && (
            <div className="flex flex-col gap-2 bg-[#0B111E]/90 border border-sky-500/40 rounded-2xl p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {attachedFile.previewDataUrl ? (
                    <img
                      src={attachedFile.previewDataUrl}
                      alt={attachedFile.name}
                      className="w-11 h-11 rounded-xl border border-amber-500/40 object-cover shrink-0 bg-slate-950"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
                      {attachedFile.mimeType === 'application/pdf' ? (
                        <FileText className="w-4 h-4 text-sky-400" />
                      ) : (
                        <Camera className="w-4 h-4 text-amber-400" />
                      )}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-slate-100 truncate">
                      {attachedFile.name}
                    </div>
                    <div className="text-[11px] text-emerald-400 flex items-center gap-2">
                      <span>
                        {attachedFile.mimeType === 'application/pdf'
                          ? '✓ PDF pronto para enviar e indexar no chat'
                          : '✓ Foto anexada pronta para análise visual'}
                      </span>
                      {attachedFile.sizeBytes && (
                        <span className="font-mono text-slate-400">
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

          {(isListeningVoice || isTranscribingAudio || voiceStatusText) && (
            <div className="mb-2 flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-rose-500/15 border border-rose-500/35 text-xs text-rose-200 animate-in fade-in duration-150">
              <span className="truncate font-medium">
                {voiceStatusText ||
                  '🎙️ Microfone ativo (Notebook / Celular) — Fale agora...'}
              </span>
              {isListeningVoice && (
                <button
                  type="button"
                  onClick={toggleChatVoiceDictation}
                  className="px-2 py-0.5 rounded-md bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[11px] shrink-0 cursor-pointer"
                >
                  Concluir
                </button>
              )}
            </div>
          )}

          {/* Main Row: (+) Button + Direct Camera Button + Input + Send Button */}
          <div className="flex items-center gap-2">
            {/* Plus Button & Popover Container */}
            <div ref={plusMenuRef} className="relative shrink-0 flex items-center gap-1.5">
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

              <button
                type="button"
                disabled={isSending}
                onClick={() => cameraInputRef.current?.click()}
                title="Tirar foto em campo com a câmera do celular"
                aria-label="Tirar foto em campo com a câmera"
                className="w-9 h-9 rounded-full bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-300 flex items-center justify-center transition-all cursor-pointer disabled:opacity-50 shrink-0"
              >
                <Camera className="w-4 h-4" />
              </button>

              {/* Floating GPT-Style Popover Menu */}
              {isPlusMenuOpen && (
                <div className="absolute bottom-full left-0 mb-3 w-80 sm:w-96 rounded-2xl bg-[#1A2234] border border-slate-700/90 shadow-2xl p-2 z-50 flex flex-col gap-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <button
                    type="button"
                    onClick={() => {
                      setIsPlusMenuOpen(false);
                      cameraInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-left transition-colors cursor-pointer group mb-1"
                  >
                    <Camera className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <span className="text-xs sm:text-sm font-semibold text-emerald-200">
                        Tirar foto agora (Câmera de Campo)
                      </span>
                      <span className="text-xs text-slate-400">
                        Sincroniza c/ Sala de Comando
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      triggerFilePicker(
                        '.pdf,application/pdf,image/jpeg,image/png,image/webp,image/*'
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
                        Enviar da galeria ou computador
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
              onChange={(e) => {
                const val = e.target.value;
                setInputText(val);
                if (keepListeningRef.current) {
                  baseTextBeforeMicRef.current = val.trim();
                  completedSessionsTextRef.current = '';
                  currentSessionFinalRef.current = '';
                  currentSessionInterimRef.current = '';
                }
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Pergunte sobre bornes, cole (Ctrl+V) uma print ou dite no microfone..."
              className={`flex-1 bg-transparent border-0 px-1 py-1.5 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none resize-none max-h-32 leading-relaxed ${
                inputText.includes('\n') || inputText.length > 90
                  ? 'overflow-y-auto'
                  : 'overflow-y-hidden'
              }`}
            />

            {/* Hands-Free Voice Dictation Button (pt-BR) — Works on Notebook & Mobile */}
            <button
              type="button"
              disabled={isSending || isTranscribingAudio}
              onClick={toggleChatVoiceDictation}
              title={
                isListeningVoice
                  ? 'Clique para concluir o ditado por voz'
                  : 'Ditar por voz no Notebook ou Celular (pt-BR)'
              }
              aria-label="Ditar por voz"
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 border ${
                isListeningVoice
                  ? 'bg-rose-600 text-white border-rose-400 animate-pulse ring-2 ring-rose-500/40'
                  : isTranscribingAudio
                    ? 'bg-amber-600/30 text-amber-300 border-amber-500/50 animate-pulse'
                    : 'bg-slate-800/90 hover:bg-slate-700 text-sky-300 border-slate-700'
              }`}
            >
              {isListeningVoice ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

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

