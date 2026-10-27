import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  CloudUpload,
  Sparkles,
  X,
  RotateCcw,
  CheckCircle2,
  Smartphone,
  Laptop,
  ArrowRight,
  Video,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';

export interface FieldPhotoCapturePayload {
  base64: string;
  mimeType: string;
  previewDataUrl: string;
  fileName: string;
  sizeBytes: number;
  panelName: string;
  fieldNote: string;
  mode: 'sync_only' | 'analyze_now';
}

interface FieldCameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeInvestigationTitle?: string;
  onCaptureSubmit: (payload: FieldPhotoCapturePayload) => Promise<void>;
}

const QUICK_PANEL_TAGS = [
  'PCPG1',
  'PCPG2',
  'CLP-SASE',
  'UHLM',
  'RV (Reg. Velocidade)',
  'QDCC (125 Vcc)',
  'QDSA',
  'CSG / QGBT',
];

const QUICK_FIELD_NOTES = [
  'Foto da régua de bornes e anilhas para conferência na Sala de Comando',
  'LED de alarme / falha aceso no cartão do CLP / relé de proteção',
  'Leitura do multímetro nos bornes durante teste com ponta de prova',
  ' Estado físico de contator / relé auxiliar / fiação no painel',
];

async function compressFieldPhotoFile(file: File): Promise<{
  base64: string;
  mimeType: string;
  previewDataUrl: string;
  sizeBytes: number;
}> {
  const rawDataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 1600;
        let width = img.naturalWidth || img.width || 1280;
        let height = img.naturalHeight || img.height || 960;

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
          const b64 = rawDataUrl.includes(',')
            ? rawDataUrl.split(',')[1]
            : rawDataUrl;
          resolve({
            base64: b64,
            mimeType: file.type || 'image/jpeg',
            previewDataUrl: rawDataUrl,
            sizeBytes: file.size,
          });
          return;
        }

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.84);
        const compressedBase64 = compressedDataUrl.includes(',')
          ? compressedDataUrl.split(',')[1]
          : compressedDataUrl;
        const approxBytes = Math.round((compressedBase64.length * 3) / 4);

        resolve({
          base64: compressedBase64,
          mimeType: 'image/jpeg',
          previewDataUrl: compressedDataUrl,
          sizeBytes: approxBytes,
        });
      } catch {
        const b64 = rawDataUrl.includes(',')
          ? rawDataUrl.split(',')[1]
          : rawDataUrl;
        resolve({
          base64: b64,
          mimeType: file.type || 'image/jpeg',
          previewDataUrl: rawDataUrl,
          sizeBytes: file.size,
        });
      }
    };
    img.onerror = () => {
      const b64 = rawDataUrl.includes(',')
        ? rawDataUrl.split(',')[1]
        : rawDataUrl;
      resolve({
        base64: b64,
        mimeType: file.type || 'image/jpeg',
        previewDataUrl: rawDataUrl,
        sizeBytes: file.size,
      });
    };
    img.src = rawDataUrl;
  });
}

export const FieldCameraModal: React.FC<FieldCameraModalProps> = ({
  isOpen,
  onClose,
  activeInvestigationTitle,
  onCaptureSubmit,
}) => {
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [isLiveVideoOpen, setIsLiveVideoOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<{
    base64: string;
    mimeType: string;
    previewDataUrl: string;
    sizeBytes: number;
    fileName: string;
  } | null>(null);

  const [selectedPanel, setSelectedPanel] = useState<string>('PCPG1');
  const [fieldNote, setFieldNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitSuccessMsg, setSubmitSuccessMsg] = useState<string | null>(null);

  const stopLiveCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setIsLiveVideoOpen(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopLiveCamera();
      setCameraError(null);
      setSubmitSuccessMsg(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        stopLiveCamera();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      stopLiveCamera();
    };
  }, []);

  if (!isOpen) return null;

  const startLiveWebRtcCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        nativeCameraInputRef.current?.click();
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      mediaStreamRef.current = stream;
      setIsLiveVideoOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 50);
    } catch {
      setCameraError(
        'Não foi possível acessar o visor ao vivo. Usando a câmera nativa do aparelho...'
      );
      nativeCameraInputRef.current?.click();
    }
  };

  const handleSnapFromLiveVideo = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const maxDim = 1600;
    let width = video.videoWidth || 1280;
    let height = video.videoHeight || 720;

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
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const approxBytes = Math.round((b64.length * 3) / 4);
    const stamp = new Date()
      .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      .replace(':', 'h');

    setCapturedPhoto({
      base64: b64,
      mimeType: 'image/jpeg',
      previewDataUrl: dataUrl,
      sizeBytes: approxBytes,
      fileName: `FOTO_CAMPO_${selectedPanel.replace(/[^A-Z0-9]/gi, '')}_${stamp}.jpg`,
    });
    stopLiveCamera();
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const compressed = await compressFieldPhotoFile(file);
    const stamp = new Date()
      .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      .replace(':', 'h');
    const cleanPanel = selectedPanel.replace(/[^A-Z0-9]/gi, '') || 'PAINEL';
    setCapturedPhoto({
      ...compressed,
      fileName: `FOTO_CAMPO_${cleanPanel}_${stamp}.jpg`,
    });
    e.target.value = '';
  };

  const handleSubmit = async (mode: 'sync_only' | 'analyze_now') => {
    if (!capturedPhoto || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitSuccessMsg(null);
    try {
      await onCaptureSubmit({
        base64: capturedPhoto.base64,
        mimeType: capturedPhoto.mimeType,
        previewDataUrl: capturedPhoto.previewDataUrl,
        fileName: capturedPhoto.fileName,
        sizeBytes: capturedPhoto.sizeBytes,
        panelName: selectedPanel.trim() || 'Painel de Campo',
        fieldNote:
          fieldNote.trim() ||
          `Foto capturada em campo no painel ${selectedPanel || 'da usina'} para continuidade de análise na Sala de Comando.`,
        mode,
      });

      if (mode === 'sync_only') {
        setSubmitSuccessMsg(
          'Foto sincronizada na Nuvem Supabase! Já está disponível para abrir no Notebook da Sala de Comando.'
        );
        setTimeout(() => {
          setCapturedPhoto(null);
          setSubmitSuccessMsg(null);
          onClose();
        }, 1400);
      } else {
        setCapturedPhoto(null);
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4 no-print">
      {/* Hidden Native Camera & Gallery Inputs */}
      <input
        ref={nativeCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileInputChange}
        className="hidden"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileInputChange}
        className="hidden"
      />

      <div className="bg-[#111827] border border-slate-700 rounded-xl max-w-2xl w-full max-h-[92vh] overflow-y-auto shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-4 py-3.5 bg-[#0B111E] border-b border-slate-800 flex items-center justify-between gap-3 sticky top-0 z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>Captura de Campo (Celular ⇄ Sala de Comando)</span>
              </h3>
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                <Smartphone className="w-3 h-3 text-emerald-400" />
                <span>Tire a foto no painel</span>
                <ArrowRight className="w-3 h-3 text-slate-500" />
                <Laptop className="w-3 h-3 text-sky-400" />
                <span>Continue no Notebook da Sala de Comando</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              stopLiveCamera();
              onClose();
            }}
            className="px-2.5 py-1.5 text-slate-400 hover:text-white bg-slate-800/80 hover:bg-rose-600/30 border border-slate-700 rounded-md flex items-center gap-1 cursor-pointer"
          >
            <span className="text-[10px] font-mono">ESC</span>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 space-y-4">
          {/* Active Investigation Context Banner */}
          <div className="p-3 rounded-lg bg-[#0B111E] border border-slate-800 flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-slate-400">Investigação vinculada: </span>
              <strong className="text-sky-300 font-mono truncate">
                {activeInvestigationTitle ||
                  'Nova Investigação de Campo (será criada automaticamente)'}
              </strong>
            </div>
            <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-300 font-mono text-[10px] shrink-0">
              Sync Nuvem Ativo
            </span>
          </div>

          {/* Step 1: Camera Capture Area */}
          {!capturedPhoto && !isLiveVideoOpen && (
            <div className="border-2 border-dashed border-emerald-500/40 bg-[#0B111E]/90 rounded-xl p-5 flex flex-col items-center justify-center text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <Camera className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-md">
                <h4 className="text-sm font-semibold text-slate-100">
                  Fotografar Painel, Régua de Bornes, Relé ou IHM
                </h4>
                <p className="text-xs text-slate-400">
                  A foto é otimizada automaticamente em alta nitidez para leitura
                  de anilhas (<code>X2:61</code>, <code>A70.0</code>) e
                  sincronizada na nuvem para abrir direto no Notebook.
                </p>
              </div>

              {cameraError && (
                <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-700/50 rounded px-3 py-1.5">
                  {cameraError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-center gap-2.5 w-full pt-1">
                <button
                  type="button"
                  onClick={() => nativeCameraInputRef.current?.click()}
                  className="px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg flex items-center gap-2 cursor-pointer shadow-lg"
                >
                  <Camera className="w-4 h-4" />
                  <span>Abrir Câmera do Celular (Nativa)</span>
                </button>

                <button
                  type="button"
                  onClick={startLiveWebRtcCamera}
                  className="px-3.5 py-2.5 text-xs font-medium text-sky-200 bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/40 rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Video className="w-4 h-4 text-sky-400" />
                  <span>Visor Ao Vivo no App</span>
                </button>

                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  className="px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <ImageIcon className="w-4 h-4 text-slate-400" />
                  <span>Escolher da Galeria</span>
                </button>
              </div>
            </div>
          )}

          {/* Live WebRTC Video Stream Viewfinder */}
          {isLiveVideoOpen && (
            <div className="rounded-xl overflow-hidden border border-sky-500/50 bg-black relative flex flex-col items-center">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full max-h-80 object-contain bg-black"
              />
              {/* Framing Reticle for Terminal Strips */}
              <div className="pointer-events-none absolute inset-6 border border-emerald-400/40 rounded-lg flex items-end justify-center pb-2">
                <span className="px-2 py-0.5 rounded bg-black/70 text-[10px] font-mono text-emerald-300">
                  Enquadre as anilhas / bornes ou LEDs do cartão
                </span>
              </div>
              <div className="w-full p-3 bg-[#0B111E] border-t border-slate-800 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleSnapFromLiveVideo}
                  className="px-5 py-2 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-full flex items-center gap-2 cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  <span>Capturar Foto Agora</span>
                </button>
                <button
                  type="button"
                  onClick={stopLiveCamera}
                  className="px-3 py-2 text-xs text-slate-300 hover:text-white bg-slate-800 rounded-md cursor-pointer"
                >
                  Cancelar Visor
                </button>
              </div>
            </div>
          )}

          {/* Preview of Captured Photo */}
          {capturedPhoto && (
            <div className="p-3 rounded-xl bg-[#0B111E] border border-emerald-500/40 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  {capturedPhoto.fileName} (
                  {Math.round(capturedPhoto.sizeBytes / 1024)} KB — Pronta p/
                  Nuvem)
                </span>
                <button
                  type="button"
                  onClick={() => setCapturedPhoto(null)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Tirar Outra Foto</span>
                </button>
              </div>

              <div className="max-h-64 overflow-hidden rounded-lg border border-slate-800 bg-black flex items-center justify-center">
                <img
                  src={capturedPhoto.previewDataUrl}
                  alt="Foto capturada em campo"
                  className="max-h-60 object-contain"
                />
              </div>
            </div>
          )}

          {/* Step 2: Quick Panel Selection (1-Tap on Mobile) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              1. Painel / Equipamento Fotografado (Toque rápido ou digite):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PANEL_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setSelectedPanel(tag)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer border ${
                    selectedPanel === tag
                      ? 'bg-sky-600 text-white border-sky-400 font-semibold'
                      : 'bg-[#0B111E] text-slate-300 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={selectedPanel}
              onChange={(e) => setSelectedPanel(e.target.value)}
              placeholder="Ex: PCPG1, Régua X2, Cartão A70.0, UHLM..."
              className="w-full mt-1 bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-md px-3 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
            />
          </div>

          {/* Step 3: Optional Field Observation */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              2. Observação Rápida de Campo (O que você viu ou mediu no painel?):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_FIELD_NOTES.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setFieldNote(preset)}
                  className="text-left px-2 py-1 rounded bg-[#0B111E] hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-300 cursor-pointer"
                >
                  + {preset}
                </button>
              ))}
            </div>
            <textarea
              rows={2}
              value={fieldNote}
              onChange={(e) => setFieldNote(e.target.value)}
              placeholder="Ex: Medi 0 Vcc no borne X2:61; LED vermelho aceso no cartão do CLP..."
              className="w-full bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-md px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>

          {submitSuccessMsg && (
            <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/50 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{submitSuccessMsg}</span>
            </div>
          )}

          {/* Action Footer */}
          <div className="pt-2 border-t border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
            <button
              type="button"
              disabled={!capturedPhoto || isSubmitting}
              onClick={() => handleSubmit('sync_only')}
              className="px-4 py-2.5 text-xs font-semibold text-emerald-200 bg-emerald-600/25 hover:bg-emerald-600/35 disabled:opacity-40 border border-emerald-500/40 rounded-lg flex items-center justify-center gap-2 cursor-pointer"
              title="Salva a foto imediatamente na nuvem para você abrir no Notebook quando chegar na Sala de Comando"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CloudUpload className="w-4 h-4 text-emerald-400" />
              )}
              <span>
                Salvar p/ Sala de Comando (Abrir no Notebook)
              </span>
            </button>

            <button
              type="button"
              disabled={!capturedPhoto || isSubmitting}
              onClick={() => handleSubmit('analyze_now')}
              className="px-4 py-2.5 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-lg flex items-center justify-center gap-2 cursor-pointer shadow-md"
              title="Sincroniza na nuvem e já analisa a foto agora com o Engenheiro Eletricista IA"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span>Salvar + Analisar Foto com IA Agora</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
