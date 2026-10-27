import React, { useRef, useState } from 'react';
import {
  Activity,
  Wrench,
  MapPin,
  PackageSearch,
  Send,
  RotateCcw,
  Mic,
  MicOff,
} from 'lucide-react';

interface FaultQueryPanelProps {
  query: string;
  setQuery: (val: string) => void;
  activeFocusTopic: string;
  setActiveFocusTopic: (val: string) => void;
  onRunDiagnosis: (overrideFocus?: string) => Promise<void>;
  isAnalyzing: boolean;
  hasPreviousTurns: boolean;
}

export interface QuickSupportButtonConfig {
  id: string;
  label: string;
  focusPrompt: string;
  icon: React.ReactNode;
}

export const QUICK_SUPPORT_BUTTONS: QuickSupportButtonConfig[] = [
  {
    id: 'multimetro',
    label: 'Onde medir com o multímetro?',
    focusPrompt:
      'Onde medir com o multímetro? Detalhe exatamente a Régua de Bornes (ex: 1X2, 2X2, 3X2, 4X2, 3XD), o número do borne para a ponta de prova vermelha (+) e preta (-), os contatos NA/NF (ex: 13-14, 21-22) e os valores esperados de tensão (125 Vcc / 220 Vca) ou continuidade em condição normal vs. falha.',
    icon: <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />,
  },
  {
    id: 'resolucao',
    label: 'Como resolver e corrigir a falha?',
    focusPrompt:
      'Como resolver e corrigir a falha? Forneça o procedimento prático de campo passo a passo, incluindo manobras físicas, substituição de fusível/componente, rearme de proteção, sentido de acionamento e alertas de bloqueio Kirk / intertravamento para chaves seccionadoras (89-5, 89-31) ou disjuntores (52G1/52G2).',
    icon: <Wrench className="w-3.5 h-3.5 text-amber-400 shrink-0" />,
  },
  {
    id: 'localizacao_me',
    label: 'Localização física (/ME)',
    focusPrompt:
      'Localização física (/ME): Consulte os Desenhos Mecânicos (/ME) anexados e indique a posição física exata do componente no painel (Coluna, porta, placa de montagem, compartimento de baixa ou média tensão) para acesso rápido da equipe de manutenção.',
    icon: <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
  },
  {
    id: 'codigo_rm',
    label: 'Código da peça na Lista de Materiais (/RM)',
    focusPrompt:
      'Código da peça na Lista de Materiais (/RM): Consulte a Relação de Materiais (/RM) do projeto e extraia a TAG exata do componente, Fabricante, Modelo/Especificação Técnica e Código de estoque/fabricante para reposição imediata.',
    icon: <PackageSearch className="w-3.5 h-3.5 text-purple-400 shrink-0" />,
  },
];

const EXAMPLE_ALARMS = [
  'Está sinalizando no supervisório baixa pressão de óleo na UHLM',
  'Falta de tensão 125Vcc no CSG2',
  'Fusível queimado na folha 4',
  'Bloqueio de fechamento do disjuntor 52G1 por intertravamento na chave 89-5',
];

export const FaultQueryPanel: React.FC<FaultQueryPanelProps> = ({
  query,
  setQuery,
  activeFocusTopic,
  setActiveFocusTopic,
  onRunDiagnosis,
  isAnalyzing,
  hasPreviousTurns,
}) => {
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const speechRecRef = useRef<{ stop: () => void } | null>(null);

  const toggleVoiceQuery = () => {
    if (isListeningVoice) {
      try {
        speechRecRef.current?.stop();
      } catch {
        // Ignore
      }
      speechRecRef.current = null;
      setIsListeningVoice(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: (event: {
          results: ArrayLike<{ 0: { transcript: string } }>;
        }) => void;
        onerror: () => void;
        onend: () => void;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        onresult: (event: {
          results: ArrayLike<{ 0: { transcript: string } }>;
        }) => void;
        onerror: () => void;
        onend: () => void;
        start: () => void;
        stop: () => void;
      };
    };

    const SpeechRecClass =
      win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRecClass) return;

    try {
      const rec = new SpeechRecClass();
      rec.lang = 'pt-BR';
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (event) => {
        const idx = event.results.length - 1;
        const transcript = event.results[idx]?.[0]?.transcript?.trim();
        if (transcript) {
          setQuery(query.trim() ? `${query.trim()} ${transcript}` : transcript);
        }
      };
      rec.onerror = () => setIsListeningVoice(false);
      rec.onend = () => setIsListeningVoice(false);
      speechRecRef.current = rec;
      setIsListeningVoice(true);
      rec.start();
    } catch {
      setIsListeningVoice(false);
    }
  };

  const handleQuickButtonClick = async (btn: QuickSupportButtonConfig) => {
    if (isAnalyzing) return;

    const isSameFocus = activeFocusTopic === btn.focusPrompt;
    const nextFocus = isSameFocus ? '' : btn.focusPrompt;
    setActiveFocusTopic(nextFocus);

    // If user already typed an alarm or already has an active diagnostic session,
    // clicking a quick support button triggers the focused analysis immediately
    if ((query.trim().length > 0 || hasPreviousTurns) && !isSameFocus) {
      await onRunDiagnosis(btn.focusPrompt);
    } else if (!query.trim()) {
      setQuery(btn.label);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isAnalyzing) return;
    await onRunDiagnosis();
  };

  return (
    <section
      aria-label="Caixa de Consulta de Falha ou Alarme"
      className="bg-[#111827] border border-slate-800 rounded-lg p-4 flex flex-col gap-3"
    >
      <div>
        <h2 className="text-sm font-semibold text-slate-100">
          2. Consulta de Falha / Alarme
        </h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          Descreva ou dite por voz o alarme do supervisório (SCADA) ou sintoma
          em campo
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-slate-300 flex items-center justify-between gap-2">
            <label htmlFor="fault-query-input">Alarme ou Sintoma</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleVoiceQuery}
                className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer border transition-colors ${
                  isListeningVoice
                    ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                    : 'bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border-sky-500/40'
                }`}
                title="Ditar alarme ou sintoma por voz (Português)"
              >
                {isListeningVoice ? (
                  <>
                    <MicOff className="w-3 h-3" />
                    <span>Ouvindo...</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-3 h-3 text-sky-400" />
                    <span>Ditar por Voz</span>
                  </>
                )}
              </button>
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setActiveFocusTopic('');
                  }}
                  className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Limpar</span>
                </button>
              )}
            </div>
          </div>

          <textarea
            id="fault-query-input"
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Ex: "Baixa pressão de óleo na UHLM", "Falta de tensão 125Vcc no CSG2"...'
            className="w-full bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-md p-2.5 text-xs sm:text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors resize-y"
          />
        </div>

        {/* Example quick-fill prompts */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">
            Exemplos rápidos (clique para preencher):
          </span>
          <div className="flex flex-wrap gap-1">
            {EXAMPLE_ALARMS.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuery(example)}
                className="text-left text-[11px] text-slate-300 hover:text-sky-300 bg-[#0B111E] hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 rounded px-2 py-0.5 transition-colors cursor-pointer truncate max-w-full"
              >
                &quot;{example}&quot;
              </button>
            ))}
          </div>
        </div>

        {/* 4 Mandatory Quick Support Buttons in Compact 2x2 Grid */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-800/80">
          <span className="text-[11px] font-medium text-slate-300">
            Foco Técnico Rápido:
          </span>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {QUICK_SUPPORT_BUTTONS.map((btn) => {
              const isSelected = activeFocusTopic === btn.focusPrompt;
              return (
                <button
                  key={btn.id}
                  type="button"
                  disabled={isAnalyzing}
                  onClick={() => handleQuickButtonClick(btn)}
                  title={btn.label}
                  className={`w-full text-left px-2.5 py-2 rounded-md border text-xs font-medium transition-colors flex items-center gap-2 cursor-pointer disabled:opacity-50 ${
                    isSelected
                      ? 'bg-sky-500/15 border-sky-500/50 text-sky-200'
                      : 'bg-[#0B111E] border-slate-800 hover:border-slate-700 text-slate-200 hover:bg-slate-800/70'
                  }`}
                >
                  {btn.icon}
                  <span className="truncate text-[11px]">{btn.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          disabled={isAnalyzing || (!query.trim() && !activeFocusTopic)}
          className="w-full py-2.5 px-4 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium text-xs rounded-md transition-colors flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>
            {isAnalyzing
              ? 'Varrendo Diagramas (/EL, /RB, /ME, /RM)...'
              : hasPreviousTurns
                ? 'Executar Nova Consulta na Sequência'
                : 'Executar Diagnóstico Eletromecânico'}
          </span>
        </button>
      </form>
    </section>
  );
};
