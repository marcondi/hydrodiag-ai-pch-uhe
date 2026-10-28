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
  Mic,
  MicOff,
  Circle,
  MoveUpRight,
  Pencil,
  Undo2,
  Trash2,
  Minus,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { UniversalVoiceDictation } from '../utils/voiceDictationEngine';

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

export type AnnotationTool = 'circle' | 'arrow' | 'pen' | 'text';

interface NormalizedPoint {
  x: number; // 0..1
  y: number; // 0..1
}

export interface PhotoAnnotationShape {
  id: string;
  tool: AnnotationTool;
  color: string;
  points: NormalizedPoint[];
  text?: string;
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
  'Estado físico de contator / relé auxiliar / fiação no painel',
];

const ANNOTATION_COLORS = [
  { label: 'Vermelho (Falha/Borne)', hex: '#EF4444' },
  { label: 'Amarelo (Atenção)', hex: '#F59E0B' },
  { label: 'Verde (Confirmado)', hex: '#10B981' },
];

export function drawAnnotationShapeOnCtx(
  ctx: CanvasRenderingContext2D,
  shape: PhotoAnnotationShape,
  width: number,
  height: number
) {
  if (shape.points.length < 1) return;
  if (shape.tool !== 'text' && shape.points.length < 2) return;

  const strokeWidth = Math.max(3, Math.round(Math.min(width, height) * 0.0075));
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = 4;

  const first = shape.points[0];
  const last = shape.points[shape.points.length - 1];
  const x1 = first.x * width;
  const y1 = first.y * height;
  const x2 = last.x * width;
  const y2 = last.y * height;

  if (shape.tool === 'text') {
    const rawText = (shape.text || '').trim();
    if (!rawText) {
      ctx.restore();
      return;
    }
    const fontSize = Math.max(13, Math.round(Math.min(width, height) * 0.0175));
    ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;

    // Wrap text if needed (max ~42 chars per line)
    const words = rawText.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';
    for (const w of words) {
      const testLine = currentLine ? `${currentLine} ${w}` : w;
      if (testLine.length > 42 && currentLine) {
        lines.push(currentLine);
        currentLine = w;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    const padX = Math.max(8, Math.round(fontSize * 0.55));
    const padY = Math.max(6, Math.round(fontSize * 0.45));
    const lineHeight = Math.round(fontSize * 1.28);

    let maxTextWidth = 0;
    for (const line of lines) {
      const m = ctx.measureText(line);
      if (m.width > maxTextWidth) maxTextWidth = m.width;
    }

    const boxW = maxTextWidth + padX * 2;
    const boxH = lines.length * lineHeight + padY * 2;

    // Keep box inside canvas bounds
    const boxX = Math.min(Math.max(8, x1 + 10), Math.max(8, width - boxW - 8));
    const boxY = Math.min(
      Math.max(8, y1 - boxH / 2),
      Math.max(8, height - boxH - 8)
    );

    // Leader pin dot at exact clicked point + short connector line
    ctx.beginPath();
    ctx.arc(x1, y1, Math.max(4, strokeWidth * 0.9), 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(boxX, boxY + boxH / 2);
    ctx.lineWidth = Math.max(2, strokeWidth * 0.65);
    ctx.stroke();

    // Box background (high-contrast dark slate so text is readable on white schematics and dark photos)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = Math.max(2.5, strokeWidth * 0.75);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    } else {
      ctx.rect(boxX, boxY, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    // Left accent bar
    ctx.fillStyle = shape.color;
    ctx.fillRect(boxX, boxY, Math.max(4, Math.round(padX * 0.45)), boxH);

    // Draw text lines
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#F8FAFC';
    ctx.textBaseline = 'top';
    lines.forEach((line, idx) => {
      ctx.fillText(line, boxX + padX + 2, boxY + padY + idx * lineHeight);
    });
  } else if (shape.tool === 'circle') {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = Math.max(8, Math.abs(x2 - x1) / 2);
    const ry = Math.max(8, Math.abs(y2 - y1) / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.tool === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(14, strokeWidth * 4.2);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    for (let i = 1; i < shape.points.length; i++) {
      ctx.lineTo(shape.points[i].x * width, shape.points[i].y * height);
    }
    ctx.stroke();
  }

  ctx.restore();
}

async function bakeAnnotationsIntoDataUrl(
  sourceDataUrl: string,
  shapes: PhotoAnnotationShape[]
): Promise<{
  base64: string;
  previewDataUrl: string;
  sizeBytes: number;
}> {
  if (shapes.length === 0) {
    const b64 = sourceDataUrl.includes(',')
      ? sourceDataUrl.split(',')[1]
      : sourceDataUrl;
    return {
      base64: b64,
      previewDataUrl: sourceDataUrl,
      sizeBytes: Math.round((b64.length * 3) / 4),
    };
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width || 1280;
      const height = img.naturalHeight || img.height || 960;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        const b64 = sourceDataUrl.includes(',')
          ? sourceDataUrl.split(',')[1]
          : sourceDataUrl;
        resolve({
          base64: b64,
          previewDataUrl: sourceDataUrl,
          sizeBytes: Math.round((b64.length * 3) / 4),
        });
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      for (const shape of shapes) {
        drawAnnotationShapeOnCtx(ctx, shape, width, height);
      }

      const finalDataUrl = canvas.toDataURL('image/jpeg', 0.86);
      const finalB64 = finalDataUrl.includes(',')
        ? finalDataUrl.split(',')[1]
        : finalDataUrl;
      resolve({
        base64: finalB64,
        previewDataUrl: finalDataUrl,
        sizeBytes: Math.round((finalB64.length * 3) / 4),
      });
    };
    img.onerror = () => {
      const b64 = sourceDataUrl.includes(',')
        ? sourceDataUrl.split(',')[1]
        : sourceDataUrl;
      resolve({
        base64: b64,
        previewDataUrl: sourceDataUrl,
        sizeBytes: Math.round((b64.length * 3) / 4),
      });
    };
    img.src = sourceDataUrl;
  });
}

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
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const voiceEngineRef = useRef<UniversalVoiceDictation | null>(null);

  const [isLiveVideoOpen, setIsLiveVideoOpen] = useState(false);
  const [windowState, setWindowState] = useState<'normal' | 'maximized' | 'minimized'>('normal');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<{
    base64: string;
    mimeType: string;
    previewDataUrl: string;
    sizeBytes: number;
    fileName: string;
  } | null>(null);

  // Annotation ("Caneta de Inspeção") state
  const [annotationTool, setAnnotationTool] =
    useState<AnnotationTool>('circle');
  const [annotationColor, setAnnotationColor] = useState<string>('#EF4444');
  const [annotations, setAnnotations] = useState<PhotoAnnotationShape[]>([]);
  const [activeShape, setActiveShape] = useState<PhotoAnnotationShape | null>(
    null
  );

  // Voice Dictation ("Mãos Ocupadas com Multímetro") state
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [voiceStatusText, setVoiceStatusText] = useState<string | null>(null);

  const [selectedPanel, setSelectedPanel] = useState<string>('PCPG1');
  const [fieldNote, setFieldNote] = useState<string>('');
  const fieldNoteRef = useRef<string>('');
  fieldNoteRef.current = fieldNote;
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitSuccessMsg, setSubmitSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    const engine = new UniversalVoiceDictation({
      getInitialText: () => fieldNoteRef.current,
      onTextUpdate: (fullText) => {
        fieldNoteRef.current = fullText;
        setFieldNote(fullText);
      },
      onStateChange: (st) => {
        setIsListeningVoice(st.isRecording);
        setVoiceStatusText(st.statusMessage);
      },
    });
    voiceEngineRef.current = engine;
    return () => {
      engine.destroy();
    };
  }, []);

  const stopLiveCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setIsLiveVideoOpen(false);
  };

  const stopVoiceDictation = () => {
    if (voiceEngineRef.current?.getIsRecording()) {
      void voiceEngineRef.current.stop();
    }
    setIsListeningVoice(false);
    setVoiceStatusText(null);
  };

  useEffect(() => {
    if (!isOpen) {
      stopLiveCamera();
      stopVoiceDictation();
      setCameraError(null);
      setSubmitSuccessMsg(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        stopLiveCamera();
        stopVoiceDictation();
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
      stopVoiceDictation();
    };
  }, []);

  // Re-render annotations on the interactive overlay canvas
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const allShapes = activeShape
      ? [...annotations, activeShape]
      : annotations;
    for (const shape of allShapes) {
      drawAnnotationShapeOnCtx(ctx, shape, canvas.width, canvas.height);
    }
  }, [annotations, activeShape, capturedPhoto]);

  if (!isOpen) return null;

  const toggleVoiceDictation = async () => {
    const engine = voiceEngineRef.current;
    if (!engine) return;
    if (engine.getIsRecording()) {
      await engine.stop();
    } else if (!engine.getIsTranscribing()) {
      await engine.start();
    }
  };

  const getNormalizedPointFromEvent = (
    clientX: number,
    clientY: number
  ): NormalizedPoint | null => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return { x, y };
  };

  const handlePointerStart = (clientX: number, clientY: number) => {
    const pt = getNormalizedPointFromEvent(clientX, clientY);
    if (!pt) return;
    setActiveShape({
      id: `ann_${Date.now()}`,
      tool: annotationTool,
      color: annotationColor,
      points: [pt, pt],
    });
  };

  const handlePointerMove = (clientX: number, clientY: number) => {
    if (!activeShape) return;
    const pt = getNormalizedPointFromEvent(clientX, clientY);
    if (!pt) return;
    setActiveShape((prev) => {
      if (!prev) return null;
      if (prev.tool === 'pen') {
        return { ...prev, points: [...prev.points, pt] };
      }
      return { ...prev, points: [prev.points[0], pt] };
    });
  };

  const handlePointerEnd = () => {
    if (!activeShape) return;
    setAnnotations((prev) => [...prev, activeShape]);
    setActiveShape(null);
  };

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

    setAnnotations([]);
    setActiveShape(null);
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
    setAnnotations([]);
    setActiveShape(null);
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
      const baked = await bakeAnnotationsIntoDataUrl(
        capturedPhoto.previewDataUrl,
        annotations
      );

      await onCaptureSubmit({
        base64: baked.base64,
        mimeType: capturedPhoto.mimeType,
        previewDataUrl: baked.previewDataUrl,
        fileName: capturedPhoto.fileName,
        sizeBytes: baked.sizeBytes,
        panelName: selectedPanel.trim() || 'Painel de Campo',
        fieldNote:
          fieldNote.trim() ||
          `Foto capturada em campo no painel ${selectedPanel || 'da usina'}${annotations.length > 0 ? ' (com marcação visual em vermelho/amarelo no ponto inspecionado)' : ''} para continuidade de análise na Sala de Comando.`,
        mode,
      });

      if (mode === 'sync_only') {
        setSubmitSuccessMsg(
          'Foto sincronizada na Nuvem Supabase! Já está disponível para abrir no Notebook da Sala de Comando.'
        );
        setTimeout(() => {
          setCapturedPhoto(null);
          setAnnotations([]);
          setSubmitSuccessMsg(null);
          onClose();
        }, 1400);
      } else {
        setCapturedPhoto(null);
        setAnnotations([]);
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={
        windowState === 'minimized'
          ? 'fixed bottom-4 left-4 z-50 no-print'
          : windowState === 'maximized'
            ? 'fixed inset-0 w-full h-full z-50 bg-[#0B111E] flex items-stretch justify-stretch no-print'
            : 'fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4 no-print'
      }
    >
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

      {windowState === 'minimized' ? (
        <div className="bg-[#111827] border-2 border-emerald-500/70 rounded-xl shadow-2xl px-3.5 py-2.5 flex items-center gap-3 max-w-[95vw] sm:max-w-lg backdrop-blur-md">
          <div
            onClick={() => setWindowState('normal')}
            className="flex items-center gap-2.5 min-w-0 cursor-pointer"
            title="Restaurar janela de Captura de Campo"
          >
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <Camera className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-mono font-bold text-white block truncate">
                Captura de Campo (Minimizada)
              </span>
              <span className="text-[10px] font-mono text-slate-400 block truncate">
                Clique para restaurar ou maximizar
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 border-l border-slate-700 pl-2.5">
            <button
              type="button"
              onClick={() => setWindowState('normal')}
              className="px-2.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Restaurar</span>
            </button>
            <button
              type="button"
              onClick={() => setWindowState('maximized')}
              className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-sky-600/30 border border-slate-700 text-slate-200 text-xs font-mono font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5 text-sky-400" />
              <span>Maximizar</span>
            </button>
            <button
              type="button"
              onClick={() => {
                stopLiveCamera();
                stopVoiceDictation();
                setWindowState('normal');
                onClose();
              }}
              className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-rose-600/40 border border-slate-700 text-slate-300 text-xs font-mono font-semibold flex items-center gap-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5 text-rose-400" />
              <span>Fechar</span>
            </button>
          </div>
        </div>
      ) : (
      <div
        className={
          windowState === 'maximized'
            ? 'bg-[#111827] w-full h-full max-w-none max-h-none rounded-none border-0 overflow-y-auto shadow-2xl flex flex-col'
            : 'bg-[#111827] border border-slate-700 rounded-xl max-w-2xl w-full max-h-[92vh] overflow-y-auto shadow-2xl flex flex-col'
        }
      >
        {/* Header */}
        <div className="px-4 py-3 bg-[#0B111E] border-b border-slate-800 flex items-center justify-between gap-3 sticky top-0 z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <Camera className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2 truncate">
                <span>Captura de Campo (Celular ⇄ Sala de Comando)</span>
              </h3>
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5 truncate">
                <Smartphone className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>Tire a foto e circule o borne</span>
                <ArrowRight className="w-3 h-3 text-slate-500 shrink-0" />
                <Laptop className="w-3 h-3 text-sky-400 shrink-0" />
                <span>Continue no Notebook</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-[#111827] border border-slate-700 rounded-lg p-1 shrink-0">
            <button
              type="button"
              onClick={() => setWindowState('minimized')}
              className="px-2 py-1 text-xs font-mono font-semibold text-slate-200 hover:text-white bg-slate-800/80 hover:bg-amber-500/20 border border-slate-700 rounded flex items-center gap-1 cursor-pointer"
              title="Minimizar janela"
            >
              <Minus className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">Minimizar</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setWindowState((prev) =>
                  prev === 'maximized' ? 'normal' : 'maximized'
                )
              }
              className="px-2 py-1 text-xs font-mono font-semibold text-sky-200 hover:text-white bg-sky-600/20 hover:bg-sky-500/30 border border-sky-500/40 rounded flex items-center gap-1 cursor-pointer"
              title={
                windowState === 'maximized'
                  ? 'Restaurar tamanho normal'
                  : 'Maximizar janela'
              }
            >
              {windowState === 'maximized' ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5 text-sky-300" />
                  <span className="hidden sm:inline">Restaurar</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5 text-sky-300" />
                  <span className="hidden sm:inline">Maximizar</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                stopLiveCamera();
                stopVoiceDictation();
                setWindowState('normal');
                onClose();
              }}
              className="px-2 py-1 text-xs font-mono font-semibold text-slate-200 hover:text-white bg-rose-950/50 hover:bg-rose-600/40 border border-rose-700/50 rounded flex items-center gap-1 cursor-pointer"
              title="Fechar janela (ESC)"
            >
              <X className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden sm:inline">Fechar</span>
            </button>
          </div>
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
                  Após tirar a foto, você pode <strong>circular em vermelho</strong>{' '}
                  o borne ou relé na própria tela e usar o{' '}
                  <strong>ditado por voz</strong> enquanto segura o multímetro.
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

          {/* Preview of Captured Photo + Interactive Inspection Pen ("Caneta de Inspeção") */}
          {capturedPhoto && (
            <div className="p-3 rounded-xl bg-[#0B111E] border border-emerald-500/40 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  {capturedPhoto.fileName} (
                  {Math.round(capturedPhoto.sizeBytes / 1024)} KB)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCapturedPhoto(null);
                    setAnnotations([]);
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Tirar Outra Foto</span>
                </button>
              </div>

              {/* Caneta de Inspeção Toolbar */}
              <div className="p-2 rounded-lg bg-[#111827] border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-300 mr-1">
                    Caneta de Inspeção:
                  </span>
                  <button
                    type="button"
                    onClick={() => setAnnotationTool('circle')}
                    className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 cursor-pointer border ${
                      annotationTool === 'circle'
                        ? 'bg-rose-500/20 border-rose-500 text-rose-200 font-semibold'
                        : 'bg-[#0B111E] border-slate-700 text-slate-300'
                    }`}
                    title="Arraste sobre a foto para circular um borne, relé ou LED"
                  >
                    <Circle className="w-3 h-3" />
                    <span>Círculo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnnotationTool('arrow')}
                    className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 cursor-pointer border ${
                      annotationTool === 'arrow'
                        ? 'bg-rose-500/20 border-rose-500 text-rose-200 font-semibold'
                        : 'bg-[#0B111E] border-slate-700 text-slate-300'
                    }`}
                    title="Arraste sobre a foto para apontar uma seta para o componente"
                  >
                    <MoveUpRight className="w-3 h-3" />
                    <span>Seta</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnnotationTool('pen')}
                    className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 cursor-pointer border ${
                      annotationTool === 'pen'
                        ? 'bg-rose-500/20 border-rose-500 text-rose-200 font-semibold'
                        : 'bg-[#0B111E] border-slate-700 text-slate-300'
                    }`}
                    title="Traço livre sobre a foto"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>Traço</span>
                  </button>

                  {/* Color Swatches */}
                  <div className="flex items-center gap-1 ml-1">
                    {ANNOTATION_COLORS.map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setAnnotationColor(c.hex)}
                        title={c.label}
                        style={{ backgroundColor: c.hex }}
                        className={`w-5 h-5 rounded-full cursor-pointer border-2 ${
                          annotationColor === c.hex
                            ? 'border-white scale-110'
                            : 'border-transparent opacity-70'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                {annotations.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setAnnotations((prev) => prev.slice(0, -1))
                      }
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] flex items-center gap-1 cursor-pointer"
                    >
                      <Undo2 className="w-3 h-3" />
                      <span>Desfazer</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAnnotations([])}
                      className="px-2 py-1 rounded bg-rose-950/60 hover:bg-rose-900/60 text-rose-200 text-[11px] flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Limpar</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="relative max-h-72 overflow-hidden rounded-lg border border-slate-800 bg-black flex items-center justify-center select-none">
                <div className="relative inline-block">
                  <img
                    src={capturedPhoto.previewDataUrl}
                    alt="Foto capturada em campo"
                    className="max-h-64 w-auto object-contain block pointer-events-none"
                  />
                  <canvas
                    ref={overlayCanvasRef}
                    width={800}
                    height={600}
                    onMouseDown={(e) => handlePointerStart(e.clientX, e.clientY)}
                    onMouseMove={(e) => handlePointerMove(e.clientX, e.clientY)}
                    onMouseUp={handlePointerEnd}
                    onMouseLeave={handlePointerEnd}
                    onTouchStart={(e) => {
                      if (e.touches.length === 1) {
                        e.preventDefault();
                        handlePointerStart(
                          e.touches[0].clientX,
                          e.touches[0].clientY
                        );
                      }
                    }}
                    onTouchMove={(e) => {
                      if (e.touches.length === 1) {
                        e.preventDefault();
                        handlePointerMove(
                          e.touches[0].clientX,
                          e.touches[0].clientY
                        );
                      }
                    }}
                    onTouchEnd={() => handlePointerEnd()}
                    className="absolute inset-0 w-full h-full cursor-crosshair touch-none"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-400 text-center">
                Dica: Arraste o dedo ou mouse sobre a foto acima para{' '}
                <strong className="text-rose-300">
                  circular ou apontar com seta
                </strong>{' '}
                o borne/LED defeituoso.
              </p>
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

          {/* Step 3: Field Observation + Hands-Free Voice Dictation */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-medium text-slate-300">
                2. Observação Rápida de Campo (Digite ou dite por voz):
              </label>

              <button
                type="button"
                onClick={toggleVoiceDictation}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer border transition-colors ${
                  isListeningVoice
                    ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                    : 'bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border-sky-500/40'
                }`}
                title="Ditar medição por voz enquanto segura as pontas de prova do multímetro"
              >
                {isListeningVoice ? (
                  <>
                    <MicOff className="w-3.5 h-3.5" />
                    <span>Parar Ditado</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-3.5 h-3.5 text-sky-400" />
                    <span>Ditar por Voz (Mãos Livres)</span>
                  </>
                )}
              </button>
            </div>

            {voiceStatusText && (
              <div className="px-3 py-1.5 rounded bg-rose-950/50 border border-rose-500/40 text-[11px] text-rose-200 font-mono">
                🎙️ {voiceStatusText}
              </div>
            )}

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
              <span>Salvar p/ Sala de Comando (Abrir no Notebook)</span>
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
      )}
    </div>
  );
};
