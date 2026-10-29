export interface VoiceDictationCallbacks {
  getInitialText: () => string;
  onTextUpdate: (fullText: string) => void;
  onStateChange: (state: {
    isRecording: boolean;
    isTranscribing: boolean;
    audioLevel: number; // 0 to 100
    elapsedSeconds: number;
    statusMessage: string | null;
  }) => void;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      0: { transcript: string };
    };
  };
}

interface BrowserSpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

interface BrowserSpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });
}

export async function requestAudioTranscription(
  blob: Blob,
  mimeType: string
): Promise<string> {
  const base64Audio = await blobToBase64(blob);
  if (!base64Audio || base64Audio.length < 100) {
    return '';
  }

  const cleanMimeType =
    (mimeType || blob.type || 'audio/webm').split(';')[0].trim() ||
    'audio/webm';

  const response = await fetch('/api/serverless-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'transcribe_audio',
      audioBase64: base64Audio,
      mimeType: cleanMimeType,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const rawText = await response.text();
  const parsed = JSON.parse(rawText.trim()) as {
    transcript?: string;
    error?: string;
  };
  return (parsed.transcript || '').trim();
}

export class UniversalVoiceDictation {
  private callbacks: VoiceDictationCallbacks;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private speechRecognition: BrowserSpeechRecognitionInstance | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: BlobPart[] = [];
  private isRecording = false;
  private isTranscribing = false;
  private audioLevel = 0;
  private elapsedSeconds = 0;
  private statusMessage: string | null = null;
  private baseText = '';
  private latestTranscript = '';
  private webSpeechFinalText = '';
  private webSpeechInterimText = '';
  private meterTimer: number | null = null;
  private clockTimer: number | null = null;
  private liveSyncTimer: number | null = null;
  private statusClearTimer: number | null = null;
  private isLiveSyncInFlight = false;
  private lastSyncedChunkCount = 0;
  private selectedMimeType = 'audio/webm';
  private finalizePromiseResolve: ((finalText: string) => void) | null = null;

  constructor(callbacks: VoiceDictationCallbacks) {
    this.callbacks = callbacks;
  }

  private emitState() {
    this.callbacks.onStateChange({
      isRecording: this.isRecording,
      isTranscribing: this.isTranscribing,
      audioLevel: this.audioLevel,
      elapsedSeconds: this.elapsedSeconds,
      statusMessage: this.statusMessage,
    });
  }

  public updateBaseTextFromManualEdit(newText: string) {
    this.baseText = newText.trim();
    this.latestTranscript = '';
    this.webSpeechFinalText = '';
    this.webSpeechInterimText = '';
  }

  public getIsRecording(): boolean {
    return this.isRecording;
  }

  public getIsTranscribing(): boolean {
    return this.isTranscribing;
  }

  private startBrowserSpeechRecognition(): boolean {
    try {
      const win = window as unknown as {
        SpeechRecognition?: new () => BrowserSpeechRecognitionInstance;
        webkitSpeechRecognition?: new () => BrowserSpeechRecognitionInstance;
      };
      const SpeechRecCtor =
        win.SpeechRecognition || win.webkitSpeechRecognition;
      if (!SpeechRecCtor) return false;

      const recognition = new SpeechRecCtor();
      recognition.lang = 'pt-BR';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        if (!this.isRecording) return;
        let finalPart = '';
        let interimPart = '';
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          const textPiece = (res[0]?.transcript || '').trim();
          if (!textPiece) continue;
          if (res.isFinal) {
            finalPart += (finalPart ? ' ' : '') + textPiece;
          } else {
            interimPart += (interimPart ? ' ' : '') + textPiece;
          }
        }
        this.webSpeechFinalText = finalPart;
        this.webSpeechInterimText = interimPart;
        const combinedSpeech = [finalPart, interimPart]
          .filter(Boolean)
          .join(' ')
          .trim();
        if (combinedSpeech) {
          this.latestTranscript = combinedSpeech;
          const fullText = [this.baseText, combinedSpeech]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          this.callbacks.onTextUpdate(fullText);
        }
      };

      recognition.onerror = () => {
        // Ignore; MediaRecorder + Gemini fallback handles transcription
      };

      recognition.onend = () => {
        // Keep restarting if still recording and MediaRecorder is active
        if (this.isRecording && this.speechRecognition === recognition) {
          try {
            recognition.start();
          } catch {
            // Ignore restart restriction
          }
        }
      };

      recognition.start();
      this.speechRecognition = recognition;
      return true;
    } catch {
      return false;
    }
  }

  public async start(): Promise<void> {
    if (this.isRecording || this.isTranscribing) {
      return;
    }

    if (this.statusClearTimer !== null) {
      window.clearTimeout(this.statusClearTimer);
      this.statusClearTimer = null;
    }

    this.baseText = this.callbacks.getInitialText().trim();
    this.latestTranscript = '';
    this.webSpeechFinalText = '';
    this.webSpeechInterimText = '';
    this.chunks = [];
    this.lastSyncedChunkCount = 0;
    this.elapsedSeconds = 0;
    this.audioLevel = 15;

    // 1. Immediate visual feedback at t=0ms so clicking the mic button on PC ALWAYS reacts immediately!
    this.isRecording = true;
    this.statusMessage =
      '🎙️ Ouvindo pelo microfone — Fale agora o alarme ou sintoma...';
    this.emitState();

    // 2. Start native browser SpeechRecognition synchronously inside user click gesture (instant word-by-word on Chrome/Edge)
    const hasWebSpeech = this.startBrowserSpeechRecognition();

    // Elapsed seconds counter starts immediately
    this.clockTimer = window.setInterval(() => {
      if (!this.isRecording) return;
      this.elapsedSeconds += 1;
      this.emitState();
    }, 1000);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (hasWebSpeech) {
        // Keep recording via Web Speech API even if getUserMedia is unavailable
        return;
      }
      this.cleanupTimersAndStream();
      this.isRecording = false;
      this.statusMessage =
        '⚠️ Navegador sem suporte direto ao microfone. Verifique se está acessando via HTTPS ou envie um arquivo de áudio.';
      this.emitState();
      this.statusClearTimer = window.setTimeout(() => {
        this.statusMessage = null;
        this.emitState();
      }, 7000);
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        // Fallback for PC sound cards/drivers that reject specific audio constraints
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // If user clicked stop while getUserMedia was resolving
      if (!this.isRecording) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.mediaStream = stream;

      // Setup Web Audio API VU Meter so the operator sees live voice bars
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
          if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume().catch(() => {});
          }
          const source = this.audioContext.createMediaStreamSource(stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          source.connect(this.analyser);

          const dataArray = new Uint8Array(this.analyser.fftSize);
          this.meterTimer = window.setInterval(() => {
            if (!this.analyser || !this.isRecording) return;
            this.analyser.getByteTimeDomainData(dataArray);
            let sumSquares = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const normalized = (dataArray[i] - 128) / 128;
              sumSquares += normalized * normalized;
            }
            const rms = Math.sqrt(sumSquares / dataArray.length);
            const scaledLevel = Math.min(100, Math.round(rms * 340));
            this.audioLevel = Math.max(8, scaledLevel);
            this.emitState();
          }, 70);
        }
      } catch {
        // Ignore if AudioContext is restricted
      }

      const candidateMimes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      let chosenMime = '';
      for (const mime of candidateMimes) {
        if (
          typeof MediaRecorder !== 'undefined' &&
          MediaRecorder.isTypeSupported(mime)
        ) {
          chosenMime = mime;
          break;
        }
      }
      this.selectedMimeType = chosenMime || 'audio/webm';

      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          this.chunks.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        this.cleanupTimersAndStream();
        await this.performFinalTranscription();
      };

      this.mediaRecorder = recorder;
      this.statusMessage =
        '🎙️ Gravando sua voz — Fale o sintoma e clique em "Concluir Voz" para transcrever';
      this.emitState();

      // Request data chunks every 500ms so we always have fresh audio buffered
      recorder.start(500);

      // Live partial transcription every 4.0 seconds while speaking
      this.liveSyncTimer = window.setInterval(() => {
        void this.performLivePartialTranscription();
      }, 4000);
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      this.cleanupTimersAndStream();
      this.isRecording = false;
      this.isTranscribing = false;

      if (
        errName === 'NotFoundError' ||
        errName === 'DevicesNotFoundError'
      ) {
        this.statusMessage =
          '⚠️ Nenhum microfone físico foi detectado conectado neste PC. Conecte um fone/microfone ou use o botão "Enviar Áudio".';
      } else if (
        errName === 'NotAllowedError' ||
        errName === 'PermissionDeniedError'
      ) {
        this.statusMessage =
          '⚠️ Acesso ao microfone bloqueado no navegador. Clique no ícone de cadeado na barra de endereço (topo da página) e permita o Microfone.';
      } else {
        this.statusMessage =
          '⚠️ Não foi possível acessar o microfone deste PC. Verifique se o microfone está habilitado no Windows e permitido no navegador.';
      }

      this.emitState();
      this.statusClearTimer = window.setTimeout(() => {
        this.statusMessage = null;
        this.emitState();
      }, 9000);
    }
  }

  private async performLivePartialTranscription(): Promise<void> {
    if (
      !this.isRecording ||
      this.isTranscribing ||
      this.isLiveSyncInFlight ||
      this.chunks.length <= this.lastSyncedChunkCount ||
      this.chunks.length < 3
    ) {
      return;
    }

    this.isLiveSyncInFlight = true;
    const snapshotCount = this.chunks.length;

    try {
      const snapshotBlob = new Blob(this.chunks.slice(0, snapshotCount), {
        type: this.selectedMimeType,
      });
      if (snapshotBlob.size < 1000) {
        return;
      }

      const transcript = await requestAudioTranscription(
        snapshotBlob,
        this.selectedMimeType
      );
      if (transcript && this.isRecording) {
        this.lastSyncedChunkCount = snapshotCount;
        this.latestTranscript = transcript;
        const fullText = [this.baseText, this.latestTranscript]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        this.callbacks.onTextUpdate(fullText);
      }
    } catch {
      // Ignore partial sync errors; final transcription on stop will still run
    } finally {
      this.isLiveSyncInFlight = false;
    }
  }

  private async performFinalTranscription(): Promise<void> {
    const webSpeechCombined = [
      this.webSpeechFinalText,
      this.webSpeechInterimText,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (this.chunks.length === 0) {
      this.isRecording = false;
      this.isTranscribing = false;
      this.statusMessage = null;
      this.emitState();
      const current = [
        this.baseText,
        this.latestTranscript || webSpeechCombined,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (current) {
        this.callbacks.onTextUpdate(current);
      }
      if (this.finalizePromiseResolve) {
        this.finalizePromiseResolve(current);
        this.finalizePromiseResolve = null;
      }
      return;
    }

    const fullBlob = new Blob(this.chunks, { type: this.selectedMimeType });
    if (fullBlob.size < 350) {
      this.isRecording = false;
      this.isTranscribing = false;
      this.statusMessage = null;
      this.emitState();
      const current = [
        this.baseText,
        this.latestTranscript || webSpeechCombined,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (current) {
        this.callbacks.onTextUpdate(current);
      }
      if (this.finalizePromiseResolve) {
        this.finalizePromiseResolve(current);
        this.finalizePromiseResolve = null;
      }
      return;
    }

    this.isRecording = false;
    this.isTranscribing = true;
    this.audioLevel = 0;
    this.statusMessage = '⏳ Transcrevendo sua fala técnica (pt-BR)...';
    this.emitState();

    let finalFullText = [
      this.baseText,
      this.latestTranscript || webSpeechCombined,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    try {
      const transcript = await requestAudioTranscription(
        fullBlob,
        this.selectedMimeType
      );
      if (transcript) {
        this.latestTranscript = transcript;
        finalFullText = [this.baseText, this.latestTranscript]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        this.callbacks.onTextUpdate(finalFullText);
      } else if (finalFullText) {
        this.callbacks.onTextUpdate(finalFullText);
      }
    } catch {
      if (finalFullText) {
        this.callbacks.onTextUpdate(finalFullText);
      }
    } finally {
      this.isTranscribing = false;
      this.statusMessage = null;
      this.chunks = [];
      this.emitState();
      if (this.finalizePromiseResolve) {
        this.finalizePromiseResolve(finalFullText);
        this.finalizePromiseResolve = null;
      }
    }
  }

  public stop(): Promise<string> {
    if (!this.isRecording) {
      return Promise.resolve(this.callbacks.getInitialText());
    }

    return new Promise<string>((resolve) => {
      this.finalizePromiseResolve = resolve;
      this.isRecording = false;

      if (this.speechRecognition) {
        try {
          this.speechRecognition.onend = null;
          this.speechRecognition.stop();
        } catch {
          // Ignore
        }
        this.speechRecognition = null;
      }

      if (
        this.mediaRecorder &&
        this.mediaRecorder.state !== 'inactive'
      ) {
        try {
          this.mediaRecorder.requestData();
        } catch {
          // Ignore
        }
        try {
          this.mediaRecorder.stop();
        } catch {
          this.cleanupTimersAndStream();
          void this.performFinalTranscription();
        }
      } else {
        this.cleanupTimersAndStream();
        void this.performFinalTranscription();
      }
    });
  }

  public destroy(): void {
    this.isRecording = false;
    this.isTranscribing = false;
    if (this.statusClearTimer !== null) {
      window.clearTimeout(this.statusClearTimer);
      this.statusClearTimer = null;
    }
    this.cleanupTimersAndStream();
  }

  private cleanupTimersAndStream(): void {
    if (this.speechRecognition) {
      try {
        this.speechRecognition.onend = null;
        this.speechRecognition.abort();
      } catch {
        // Ignore
      }
      this.speechRecognition = null;
    }
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    if (this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.liveSyncTimer !== null) {
      window.clearInterval(this.liveSyncTimer);
      this.liveSyncTimer = null;
    }
    if (this.audioContext) {
      try {
        void this.audioContext.close();
      } catch {
        // Ignore
      }
      this.audioContext = null;
      this.analyser = null;
    }
    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach((track) => track.stop());
      } catch {
        // Ignore
      }
      this.mediaStream = null;
    }
  }
}
