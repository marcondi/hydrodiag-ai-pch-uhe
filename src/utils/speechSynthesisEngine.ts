/**
 * Motor de Síntese de Voz Técnica (Text-to-Speech) Mãos-Livres para Casa de Força / Cubículos PCH & UHE.
 * Converte laudos e respostas do Chat Especialista em áudio claro em Português (pt-BR),
 * expandindo grandezas e siglas elétricas (Vcc, Vca, NA, NF, Ω) para leitura natural enquanto
 * o técnico segura as pontas de prova do multímetro.
 */

export interface SpeechEngineState {
  isSpeaking: boolean;
  activeId: string | null;
}

type SpeechListener = (state: SpeechEngineState) => void;

class TechnicalSpeechEngine {
  private activeId: string | null = null;
  private isSpeaking = false;
  private listeners = new Set<SpeechListener>();
  private utteranceQueue: string[] = [];
  private currentChunkIndex = 0;
  private keepAliveTimer: number | null = null;

  public subscribe(listener: SpeechListener): () => void {
    this.listeners.add(listener);
    listener({ isSpeaking: this.isSpeaking, activeId: this.activeId });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const state: SpeechEngineState = {
      isSpeaking: this.isSpeaking,
      activeId: this.activeId,
    };
    this.listeners.forEach((cb) => {
      try {
        cb(state);
      } catch {
        // Ignore listener errors
      }
    });
  }

  public isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  /**
   * Limpa marcações Markdown e converte abreviações eletromecânicas WEG/IEC/ANSI
   * em pronúncia fluida em português brasileiro.
   */
  public formatTechnicalTextForSpeech(markdown: string): string {
    if (!markdown) return '';

    let text = markdown
      // Remover links internos #pdf-page-X mantendo apenas o texto visível
      .replace(/\[([^\]]+)\]\(#pdf-page-\d+\)/gi, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remover blocos de código extensos ou cabeçalhos markdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+>]\s+/gm, '. ')
      .replace(/\|/g, ', ')
      // Expandir unidades e siglas técnicas para fala natural no painel
      .replace(/\b(\d+(?:[.,]\d+)?)\s*Vcc\b/gi, '$1 volts corrente contínua')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*Vdc\b/gi, '$1 volts corrente contínua')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*Vca\b/gi, '$1 volts corrente alternada')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*Vac\b/gi, '$1 volts corrente alternada')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*mA\b/gi, '$1 miliampères')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*kΩ\b/gi, '$1 quilo-ohms')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*MΩ\b/gi, '$1 mega-ohms')
      .replace(/\b(\d+(?:[.,]\d+)?)\s*Ω\b/gi, '$1 ohms')
      .replace(/Ω/g, ' ohms ')
      .replace(/\(\+\)/g, ' positivo ')
      .replace(/\(-\)/g, ' negativo ')
      .replace(/\bNA\/NF\b/g, 'normalmente aberto ou fechado')
      .replace(/\bcontato\s+NA\b/gi, 'contato normalmente aberto')
      .replace(/\bcontato\s+NF\b/gi, 'contato normalmente fechado')
      .replace(/\bPág\.\s*(\d+)/gi, 'Página $1')
      .replace(/\bFl\.\s*(\d+)/gi, 'Folha $1')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  private splitIntoSpeakableChunks(cleanText: string): string[] {
    if (!cleanText) return [];
    const rawSentences = cleanText
      .split(/(?<=[.!?।:;])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);

    const chunks: string[] = [];
    let current = '';

    for (const sentence of rawSentences) {
      if ((current + ' ' + sentence).trim().length <= 200) {
        current = (current + ' ' + sentence).trim();
      } else {
        if (current) chunks.push(current);
        if (sentence.length > 220) {
          // Sub-split very long clauses by comma
          const clauses = sentence.split(/,\s*/);
          let sub = '';
          for (const cl of clauses) {
            if ((sub + ', ' + cl).trim().length <= 200) {
              sub = sub ? `${sub}, ${cl}` : cl;
            } else {
              if (sub) chunks.push(sub);
              sub = cl.slice(0, 200);
            }
          }
          current = sub;
        } else {
          current = sentence;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private pickPortugueseVoice(): SpeechSynthesisVoice | null {
    if (!this.isSupported()) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (voices.length === 0) return null;

    const ptBrVoices = voices.filter((v) =>
      v.lang.toLowerCase().replace('_', '-').startsWith('pt-br')
    );
    const ptAnyVoices = voices.filter((v) =>
      v.lang.toLowerCase().startsWith('pt')
    );

    const pool = ptBrVoices.length > 0 ? ptBrVoices : ptAnyVoices;
    if (pool.length === 0) return null;

    // Prefer natural/Google/Microsoft voices when available
    const preferred = pool.find(
      (v) =>
        /google|natural|francisca|antonio|luciana|maria|daniel/i.test(v.name)
    );
    return preferred || pool[0];
  }

  public toggleSpeak(id: string, rawMarkdown: string): void {
    if (this.isSpeaking && this.activeId === id) {
      this.stop();
      return;
    }
    this.speak(id, rawMarkdown);
  }

  public speak(id: string, rawMarkdown: string): void {
    if (!this.isSupported()) return;

    this.stop();

    const formatted = this.formatTechnicalTextForSpeech(rawMarkdown);
    const chunks = this.splitIntoSpeakableChunks(formatted);
    if (chunks.length === 0) return;

    this.activeId = id;
    this.isSpeaking = true;
    this.utteranceQueue = chunks;
    this.currentChunkIndex = 0;
    this.notify();

    // Chrome keep-alive workaround for utterances > 15s
    this.keepAliveTimer = window.setInterval(() => {
      if (window.speechSynthesis && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 10000);

    this.speakNextChunk();
  }

  private speakNextChunk(): void {
    if (
      !this.isSupported() ||
      !this.isSpeaking ||
      this.currentChunkIndex >= this.utteranceQueue.length
    ) {
      this.finish();
      return;
    }

    const chunkText = this.utteranceQueue[this.currentChunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunkText);
    utterance.lang = 'pt-BR';
    utterance.rate = 1.04; // Ritmo técnico ágil e claro
    utterance.pitch = 1.0;

    const voice = this.pickPortugueseVoice();
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onend = () => {
      if (!this.isSpeaking) return;
      this.currentChunkIndex += 1;
      if (this.currentChunkIndex < this.utteranceQueue.length) {
        this.speakNextChunk();
      } else {
        this.finish();
      }
    };

    utterance.onerror = () => {
      this.finish();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      this.finish();
    }
  }

  public stop(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.isSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore cancel error
      }
    }
    this.finish();
  }

  private finish(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.isSpeaking = false;
    this.activeId = null;
    this.utteranceQueue = [];
    this.currentChunkIndex = 0;
    this.notify();
  }
}

export const technicalSpeechEngine = new TechnicalSpeechEngine();
