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

async function requestAudioTranscription(
  blob: Blob,
  mimeType: string
): Promise<string> {
  const base64Audio = await blobToBase64(blob);
  if (!base64Audio || base64Audio.length < 120) {
    return '';
  }

  const response = await fetch('/api/serverless-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'transcribe_audio',
      audioBase64: base64Audio,
      mimeType: mimeType || blob.type || 'audio/webm',
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
  private meterTimer: number | null = null;
  private clockTimer: number | null = null;
  private liveSyncTimer: number | null = null;
  private isLiveSyncInFlight = false;
  private lastSyncedChunkCount = 0;
  private hadVoiceActivitySinceLastSync = false;
  private everHadVoiceActivity = false;
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
  }

  public getIsRecording(): boolean {
    return this.isRecording;
  }

  public getIsTranscribing(): boolean {
    return this.isTranscribing;
  }

  public async start(): Promise<void> {
    if (this.isRecording || this.isTranscribing) {
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.statusMessage =
        '⚠️ Navegador sem suporte a captura de microfone (getUserMedia).';
      this.emitState();
      setTimeout(() => {
        this.statusMessage = null;
        this.emitState();
      }, 4000);
      return;
    }

    try {
      this.baseText = this.callbacks.getInitialText().trim();
      this.latestTranscript = '';
      this.chunks = [];
      this.lastSyncedChunkCount = 0;
      this.hadVoiceActivitySinceLastSync = false;
      this.everHadVoiceActivity = false;
      this.elapsedSeconds = 0;
      this.audioLevel = 0;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mediaStream = stream;

      // Setup Web Audio API VU Meter so the operator sees live voice bars
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
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
            this.audioLevel = scaledLevel;
            if (scaledLevel >= 7) {
              this.hadVoiceActivitySinceLastSync = true;
              this.everHadVoiceActivity = true;
            }
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
      this.isRecording = true;
      this.statusMessage =
        '🎙️ Gravando sua voz — Fale à vontade e clique em Concluir quando terminar';
      this.emitState();

      // Request data chunks every 500ms so we always have fresh audio buffered
      recorder.start(500);

      // Elapsed seconds counter
      this.clockTimer = window.setInterval(() => {
        if (!this.isRecording) return;
        this.elapsedSeconds += 1;
        this.emitState();
      }, 1000);

      // Live partial transcription every 4.2 seconds while speaking
      this.liveSyncTimer = window.setInterval(() => {
        void this.performLivePartialTranscription();
      }, 4200);
    } catch {
      this.cleanupTimersAndStream();
      this.isRecording = false;
      this.isTranscribing = false;
      this.statusMessage =
        '⚠️ Permita o acesso ao microfone no navegador para usar o ditado por voz.';
      this.emitState();
      setTimeout(() => {
        this.statusMessage = null;
        this.emitState();
      }, 4500);
    }
  }

  private async performLivePartialTranscription(): Promise<void> {
    if (
      !this.isRecording ||
      this.isTranscribing ||
      this.isLiveSyncInFlight ||
      !this.hadVoiceActivitySinceLastSync ||
      this.chunks.length <= this.lastSyncedChunkCount ||
      this.chunks.length < 3
    ) {
      return;
    }

    this.isLiveSyncInFlight = true;
    const snapshotCount = this.chunks.length;
    this.hadVoiceActivitySinceLastSync = false;

    try {
      const snapshotBlob = new Blob(this.chunks.slice(0, snapshotCount), {
        type: this.selectedMimeType,
      });
      if (snapshotBlob.size < 1500) {
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
    if (this.chunks.length === 0) {
      this.isRecording = false;
      this.isTranscribing = false;
      this.statusMessage = null;
      this.emitState();
      const current = [this.baseText, this.latestTranscript]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (this.finalizePromiseResolve) {
        this.finalizePromiseResolve(current);
        this.finalizePromiseResolve = null;
      }
      return;
    }

    const fullBlob = new Blob(this.chunks, { type: this.selectedMimeType });
    if (fullBlob.size < 800 || !this.everHadVoiceActivity) {
      this.isRecording = false;
      this.isTranscribing = false;
      this.statusMessage = null;
      this.emitState();
      const current = [this.baseText, this.latestTranscript]
        .filter(Boolean)
        .join(' ')
        .trim();
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

    let finalFullText = [this.baseText, this.latestTranscript]
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
      }
    } catch {
      // Keep latest partial transcript if final call fails
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
    this.cleanupTimersAndStream();
  }

  private cleanupTimersAndStream(): void {
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
