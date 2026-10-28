import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PDFDocument } from 'pdf-lib';
import {
  FileText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
  Download,
  Loader2,
  Upload,
  Sparkles,
  BookOpen,
  Cpu,
  CheckCircle2,
  ArrowRight,
  Layers,
  Hand,
  Grab,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Circle,
  MoveUpRight,
  Type,
  Pencil,
  Printer,
  Move,
  Undo2,
  Trash2,
  Minus,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { DiagramAttachment } from '../types';
import {
  drawAnnotationShapeOnCtx,
  PhotoAnnotationShape,
} from './FieldCameraModal';
import {
  extractReconstructedPageSheetData,
  extractSinglePdfPageUrl,
  getCachedPdfIndex,
  loadAttachmentBinaryFromVault,
  saveAttachmentBinaryToVault,
} from '../utils/pdfClientEngine';

const PDF_ANNOTATIONS_STORAGE_KEY = 'hydrodiag_pdf_sheet_annotations_v2';

type ShapeDragMode = 'move' | 'p0' | 'p1' | 'resize-br';

interface ShapeHitResult {
  shape: PhotoAnnotationShape;
  mode: ShapeDragMode;
}

let sharedMeasureCanvas: HTMLCanvasElement | null = null;
function getSharedMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!sharedMeasureCanvas) {
    sharedMeasureCanvas = document.createElement('canvas');
    sharedMeasureCanvas.width = 1200;
    sharedMeasureCanvas.height = 900;
  }
  return sharedMeasureCanvas.getContext('2d');
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);
  return Math.hypot(px - projX, py - projY);
}

function getTextAnnotationBoxMetrics(
  ctx: CanvasRenderingContext2D | null,
  shape: PhotoAnnotationShape,
  width: number,
  height: number
) {
  const activeCtx = ctx || getSharedMeasureCtx();
  const first = shape.points[0] || { x: 0.5, y: 0.5 };
  const x1 = first.x * width;
  const y1 = first.y * height;
  const rawText = (shape.text || '').trim() || 'Nota';
  const fontSize = Math.max(13, Math.round(Math.min(width, height) * 0.0175));

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
  if (activeCtx) {
    activeCtx.save();
    activeCtx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    for (const line of lines) {
      const m = activeCtx.measureText(line);
      if (m.width > maxTextWidth) maxTextWidth = m.width;
    }
    activeCtx.restore();
  } else {
    for (const line of lines) {
      const approx = line.length * fontSize * 0.62;
      if (approx > maxTextWidth) maxTextWidth = approx;
    }
  }

  const boxW = maxTextWidth + padX * 2;
  const boxH = lines.length * lineHeight + padY * 2;
  const boxX = Math.min(Math.max(8, x1 + 10), Math.max(8, width - boxW - 8));
  const boxY = Math.min(
    Math.max(8, y1 - boxH / 2),
    Math.max(8, height - boxH - 8)
  );

  return { x1, y1, boxX, boxY, boxW, boxH };
}

function hitTestAnnotationShapes(
  ctx: CanvasRenderingContext2D | null,
  shapes: PhotoAnnotationShape[],
  normX: number,
  normY: number,
  width: number,
  height: number,
  selectedShapeId: string | null
): ShapeHitResult | null {
  const px = normX * width;
  const py = normY * height;

  // 0. If a shape is already selected, check its endpoint/resize handles first
  if (selectedShapeId) {
    const sel = shapes.find((s) => s.id === selectedShapeId);
    if (sel && sel.points.length >= 2) {
      const x1 = sel.points[0].x * width;
      const y1 = sel.points[0].y * height;
      const x2 = sel.points[sel.points.length - 1].x * width;
      const y2 = sel.points[sel.points.length - 1].y * height;

      if (sel.tool === 'arrow' && Math.hypot(x2 - x1, y2 - y1) > 36) {
        if (Math.hypot(px - x1, py - y1) <= 20) {
          return { shape: sel, mode: 'p0' };
        }
        if (Math.hypot(px - x2, py - y2) <= 20) {
          return { shape: sel, mode: 'p1' };
        }
      } else if (sel.tool === 'circle') {
        const brX = Math.max(x1, x2);
        const brY = Math.max(y1, y2);
        if (Math.hypot(px - brX, py - brY) <= 22) {
          return { shape: sel, mode: 'resize-br' };
        }
      }
    }
  }

  // 1. Pass 1: Check text boxes, arrows, and circle borders (top-most first)
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.points.length < 1) continue;

    if (s.tool === 'text') {
      const { x1, y1, boxX, boxY, boxW, boxH } = getTextAnnotationBoxMetrics(
        ctx,
        s,
        width,
        height
      );
      const inBox =
        px >= boxX - 14 &&
        px <= boxX + boxW + 14 &&
        py >= boxY - 14 &&
        py <= boxY + boxH + 14;
      const nearPin = Math.hypot(px - x1, py - y1) <= 22;
      const nearConnector =
        distToSegment(px, py, x1, y1, boxX, boxY + boxH / 2) <= 16;
      if (inBox || nearPin || nearConnector) {
        return { shape: s, mode: 'move' };
      }
    } else if (s.tool === 'arrow' && s.points.length >= 2) {
      const x1 = s.points[0].x * width;
      const y1 = s.points[0].y * height;
      const x2 = s.points[s.points.length - 1].x * width;
      const y2 = s.points[s.points.length - 1].y * height;
      const segDist = distToSegment(px, py, x1, y1, x2, y2);
      const headDist = Math.hypot(px - x2, py - y2);
      const tailDist = Math.hypot(px - x1, py - y1);
      if (segDist <= 26 || headDist <= 28 || tailDist <= 24) {
        return { shape: s, mode: 'move' };
      }
    } else if (s.tool === 'circle' && s.points.length >= 2) {
      const x1 = s.points[0].x * width;
      const y1 = s.points[0].y * height;
      const x2 = s.points[s.points.length - 1].x * width;
      const y2 = s.points[s.points.length - 1].y * height;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.max(8, Math.abs(x2 - x1) / 2);
      const ry = Math.max(8, Math.abs(y2 - y1) / 2);
      const outerNorm = Math.hypot(
        (px - cx) / Math.max(1, rx + 24),
        (py - cy) / Math.max(1, ry + 24)
      );
      const innerRx = Math.max(0, rx - 24);
      const innerRy = Math.max(0, ry - 24);
      const innerNorm =
        innerRx > 4 && innerRy > 4
          ? Math.hypot((px - cx) / innerRx, (py - cy) / innerRy)
          : 999;
      if (outerNorm <= 1.08 && innerNorm >= 0.85) {
        return { shape: s, mode: 'move' };
      }
    }
  }

  // 2. Pass 2: Check inside circle interior or bounding box so user can grab anywhere on/inside a circle to move it
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.tool === 'circle' && s.points.length >= 2) {
      const x1 = s.points[0].x * width;
      const y1 = s.points[0].y * height;
      const x2 = s.points[s.points.length - 1].x * width;
      const y2 = s.points[s.points.length - 1].y * height;
      const minX = Math.min(x1, x2) - 18;
      const maxX = Math.max(x1, x2) + 18;
      const minY = Math.min(y1, y2) - 18;
      const maxY = Math.max(y1, y2) + 18;
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        return { shape: s, mode: 'move' };
      }
    }
  }

  return null;
}

function drawShapeSelectionHighlightOnCtx(
  ctx: CanvasRenderingContext2D,
  shape: PhotoAnnotationShape,
  width: number,
  height: number,
  isSelected: boolean
) {
  if (shape.points.length < 1) return;
  ctx.save();
  ctx.strokeStyle = isSelected ? '#38BDF8' : 'rgba(56, 189, 248, 0.85)';
  ctx.lineWidth = isSelected ? 2.5 : 2;
  ctx.setLineDash([6, 5]);

  if (shape.tool === 'text') {
    const { x1, y1, boxX, boxY, boxW, boxH } = getTextAnnotationBoxMetrics(
      ctx,
      shape,
      width,
      height
    );
    const minX = Math.min(x1 - 8, boxX - 6);
    const minY = Math.min(y1 - 8, boxY - 6);
    const maxX = boxX + boxW + 6;
    const maxY = Math.max(y1 + 8, boxY + boxH + 6);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    ctx.setLineDash([]);
    ctx.fillStyle = '#0284C7';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x1, y1, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (shape.tool === 'circle' && shape.points.length >= 2) {
    const x1 = shape.points[0].x * width;
    const y1 = shape.points[0].y * height;
    const x2 = shape.points[shape.points.length - 1].x * width;
    const y2 = shape.points[shape.points.length - 1].y * height;
    const minX = Math.min(x1, x2) - 6;
    const minY = Math.min(y1, y2) - 6;
    const maxX = Math.max(x1, x2) + 6;
    const maxY = Math.max(y1, y2) + 6;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    if (isSelected) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#0284C7';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(Math.max(x1, x2), Math.max(y1, y2), 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (shape.tool === 'arrow' && shape.points.length >= 2) {
    const x1 = shape.points[0].x * width;
    const y1 = shape.points[0].y * height;
    const x2 = shape.points[shape.points.length - 1].x * width;
    const y2 = shape.points[shape.points.length - 1].y * height;
    const minX = Math.min(x1, x2) - 10;
    const minY = Math.min(y1, y2) - 10;
    const maxX = Math.max(x1, x2) + 10;
    const maxY = Math.max(y1, y2) + 10;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    if (isSelected) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#0284C7';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      for (const pt of [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

function sanitizeShapesList(
  shapes: PhotoAnnotationShape[]
): PhotoAnnotationShape[] {
  if (!Array.isArray(shapes)) return [];
  return shapes.filter((s) => {
    if (!s || !Array.isArray(s.points) || s.points.length === 0) return false;
    if (s.tool === 'circle' || s.tool === 'arrow') {
      if (s.points.length < 2) return false;
      const p0 = s.points[0];
      const p1 = s.points[s.points.length - 1];
      // Filter out accidental tiny single-click / micro-drag dots
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.022) return false;
    }
    return true;
  });
}

const QUICK_PDF_TEXT_NOTES = [
  'Medir 125Vcc neste borne',
  'Borne oxidado / reapertar',
  'Testar continuidade c/ multímetro',
  'Jump provisório de teste',
  'Sinal OK confirmado em campo',
];

const PDF_ANNOTATION_COLORS = [
  { label: 'Vermelho (Falha/Borne)', hex: '#EF4444' },
  { label: 'Amarelo (Atenção)', hex: '#F59E0B' },
  { label: 'Verde (Confirmado)', hex: '#10B981' },
];

interface PdfDeepLinkDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  attachments: DiagramAttachment[];
  initialPage: number;
  initialAttachmentId?: string;
  reportMarkdown?: string;
  onAskAboutCurrentPage?: (pageNumber: number, attachmentName: string) => void;
  onRequestReupload?: () => void;
  onRelinkAttachmentBinary?: (
    attachmentId: string,
    base64Data: string,
    fileName?: string,
    sizeBytes?: number
  ) => void;
}

function pickBestAttachmentForPage(
  attachments: DiagramAttachment[],
  targetPage: number,
  initialAttachmentId?: string
): DiagramAttachment | undefined {
  if (attachments.length === 0) return undefined;
  if (initialAttachmentId) {
    const explicit = attachments.find((a) => a.id === initialAttachmentId);
    if (explicit) return explicit;
  }
  if (attachments.length === 1) return attachments[0];

  // 1. Prefer attachments that ALREADY have base64Data loaded in memory and cover targetPage
  const withBinary = attachments.filter((a) => Boolean(a.base64Data));
  for (const att of [...withBinary].reverse()) {
    const cached = getCachedPdfIndex(att);
    if (cached && cached.length > 0) {
      const maxIndexedPage = Math.max(...cached.map((b) => b.endPage));
      if (targetPage <= maxIndexedPage && maxIndexedPage > 1) {
        return att;
      }
    }
  }
  if (withBinary.length > 0) {
    return withBinary[withBinary.length - 1];
  }

  // 2. Otherwise check cached PDF index from latest attachment to oldest
  const reversed = [...attachments].reverse();
  for (const att of reversed) {
    const cached = getCachedPdfIndex(att);
    if (cached && cached.length > 0) {
      const maxIndexedPage = Math.max(...cached.map((b) => b.endPage));
      if (targetPage <= maxIndexedPage && maxIndexedPage > 1) {
        return att;
      }
    }
  }

  if (targetPage > 2) {
    const largest = [...attachments].sort(
      (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)
    )[0];
    if (largest) return largest;
  }

  return attachments[0];
}

export const PdfDeepLinkDrawer: React.FC<PdfDeepLinkDrawerProps> = ({
  isOpen,
  onClose,
  attachments,
  initialPage,
  initialAttachmentId,
  reportMarkdown,
  onAskAboutCurrentPage,
  onRelinkAttachmentBinary,
}) => {
  const drawerRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const quickRelinkInputRef = useRef<HTMLInputElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const pdfAttachments = attachments.filter(
    (a) =>
      a.mimeType === 'application/pdf' ||
      a.name.toLowerCase().endsWith('.pdf') ||
      Boolean(a.base64Data)
  );

  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string>(
    initialAttachmentId || pdfAttachments[0]?.id || ''
  );
  const [currentPage, setCurrentPage] = useState<number>(
    Math.max(1, initialPage || 1)
  );
  const [pageInput, setPageInput] = useState<string>(
    String(Math.max(1, initialPage || 1))
  );
  const [totalPages, setTotalPages] = useState<number>(1);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [useNativeIframe, setUseNativeIframe] = useState<boolean>(false);
  const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
  const [localRecoveredBase64, setLocalRecoveredBase64] = useState<
    Record<string, string>
  >({});

  // CAD Pan ("Mãozinha") & Mouse Wheel Zoom + Inspection Pen State
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isLeftClickWheelZooming, setIsLeftClickWheelZooming] =
    useState<boolean>(false);
  const [interactionMode, setInteractionMode] = useState<
    'pan' | 'circle' | 'arrow' | 'text'
  >('pan');
  const [isAnnotationMenuOpen, setIsAnnotationMenuOpen] =
    useState<boolean>(false);
  const [annotationColor, setAnnotationColor] = useState<string>('#EF4444');
  const [pendingTextPoint, setPendingTextPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pendingTextValue, setPendingTextValue] = useState<string>('');
  const [editingTextShapeId, setEditingTextShapeId] = useState<string | null>(
    null
  );
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [hoveredShapeId, setHoveredShapeId] = useState<string | null>(null);
  const [isDraggingShape, setIsDraggingShape] = useState<boolean>(false);
  const draggingShapeRef = useRef<{
    shapeId: string;
    mode: ShapeDragMode;
    startNormX: number;
    startNormY: number;
    initialPoints: { x: number; y: number }[];
  } | null>(null);

  const [isFieldPrintModalOpen, setIsFieldPrintModalOpen] =
    useState<boolean>(false);
  const [windowState, setWindowState] = useState<
    'normal' | 'maximized' | 'minimized'
  >(() => {
    try {
      const saved = localStorage.getItem('hydrodiag_pdf_window_mode_v1');
      if (saved === 'normal' || saved === 'maximized') return saved;
    } catch {
      // ignore
    }
    return 'maximized';
  });
  const [sheetFitMode, setSheetFitMode] = useState<'contain' | 'width'>(
    'contain'
  );
  const [showIndexFooter, setShowIndexFooter] = useState<boolean>(false);
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });
  const [imgNaturalSize, setImgNaturalSize] = useState<{
    width: number;
    height: number;
  }>({ width: 1600, height: 1131 });
  const [textBoxWindowState, setTextBoxWindowState] = useState<
    'normal' | 'maximized' | 'minimized'
  >('normal');
  const [printModalWindowState, setPrintModalWindowState] = useState<
    'normal' | 'maximized' | 'minimized'
  >('normal');
  const [isGeneratingFieldPrint, setIsGeneratingFieldPrint] =
    useState<boolean>(false);
  const [annotatedPrintDataUrl, setAnnotatedPrintDataUrl] = useState<
    string | null
  >(null);
  const [annotatedPdfBlobUrl, setAnnotatedPdfBlobUrl] = useState<string | null>(
    null
  );

  const [sheetAnnotations, setSheetAnnotations] = useState<
    Record<string, PhotoAnnotationShape[]>
  >(() => {
    try {
      const raw = localStorage.getItem(PDF_ANNOTATIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const cleaned: Record<string, PhotoAnnotationShape[]> = {};
          for (const [k, v] of Object.entries(parsed)) {
            cleaned[k] = sanitizeShapesList(v as PhotoAnnotationShape[]);
          }
          return cleaned;
        }
      }
    } catch {
      // ignore storage errors
    }
    return {};
  });
  const [activeSheetShape, setActiveSheetShape] =
    useState<PhotoAnnotationShape | null>(null);
  const sheetCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationMenuRef = useRef<HTMLDivElement | null>(null);

  // Persist sheetAnnotations to localStorage whenever they change so opening a specific sheet never loses annotations
  useEffect(() => {
    try {
      localStorage.setItem(
        PDF_ANNOTATIONS_STORAGE_KEY,
        JSON.stringify(sheetAnnotations)
      );
    } catch {
      // ignore quota errors
    }
  }, [sheetAnnotations]);

  // Close annotation dropdown menu on outside click
  useEffect(() => {
    if (!isAnnotationMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        annotationMenuRef.current &&
        !annotationMenuRef.current.contains(e.target as Node)
      ) {
        setIsAnnotationMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [isAnnotationMenuOpen]);

  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  }>({ startX: 0, startY: 0, originPanX: 0, originPanY: 0 });

  const zoomPanRef = useRef<{ zoom: number; panX: number; panY: number }>({
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  zoomPanRef.current = { zoom, panX: pan.x, panY: pan.y };

  const activeAttachment =
    attachments.find((a) => a.id === selectedAttachmentId) || attachments[0];

  const activeAttachmentId = activeAttachment?.id || '';
  const activeAttachmentNameKey = (activeAttachment?.name || '')
    .trim()
    .toLowerCase();
  // Canonical key by normalized filename + page so annotations persist even when opening deep-links across sessions
  const canonicalPageKey = `${activeAttachmentNameKey || activeAttachmentId}__p_${currentPage}`;
  const legacyPageKey = `${activeAttachmentId}_p_${currentPage}`;
  const pageKeysRef = useRef<{ canonical: string; legacy: string }>({
    canonical: canonicalPageKey,
    legacy: legacyPageKey,
  });
  pageKeysRef.current = {
    canonical: canonicalPageKey,
    legacy: legacyPageKey,
  };

  const currentPageShapes =
    sheetAnnotations[canonicalPageKey] ||
    sheetAnnotations[legacyPageKey] ||
    [];

  const selectedShape =
    currentPageShapes.find((s) => s.id === selectedShapeId) || null;

  const updateCurrentPageShapes = (
    updater: (prevList: PhotoAnnotationShape[]) => PhotoAnnotationShape[]
  ) => {
    const { canonical, legacy } = pageKeysRef.current;
    setSheetAnnotations((prev) => {
      const existing = prev[canonical] || prev[legacy] || [];
      const updated = updater(existing);
      return {
        ...prev,
        [canonical]: updated,
        [legacy]: updated,
      };
    });
  };

  // Reset Pan & Zoom when switching pages or files
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);
    setIsLeftClickWheelZooming(false);
    setActiveSheetShape(null);
    setPendingTextPoint(null);
    setPendingTextValue('');
    setEditingTextShapeId(null);
    setSelectedShapeId(null);
    setHoveredShapeId(null);
    setIsDraggingShape(false);
    draggingShapeRef.current = null;
  }, [currentPage, activeAttachmentId, isOpen]);

  // Render annotations + interactive selection/hover outlines on the sheet overlay canvas
  useEffect(() => {
    const canvas = sheetCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const shapesToDraw = activeSheetShape
      ? [...currentPageShapes, activeSheetShape]
      : currentPageShapes;
    for (const s of shapesToDraw) {
      drawAnnotationShapeOnCtx(ctx, s, canvas.width, canvas.height);
      if (s.id === selectedShapeId || s.id === hoveredShapeId) {
        drawShapeSelectionHighlightOnCtx(
          ctx,
          s,
          canvas.width,
          canvas.height,
          s.id === selectedShapeId
        );
      }
    }
  }, [
    currentPageShapes,
    activeSheetShape,
    selectedShapeId,
    hoveredShapeId,
    pageImageUrl,
    currentPage,
    useNativeIframe,
  ]);

  // Lookup cached AI summary for the current page if available
  const cachedBatches = activeAttachment
    ? getCachedPdfIndex(activeAttachment)
    : null;
  const reconstructedSheet = extractReconstructedPageSheetData(
    currentPage,
    activeAttachment?.name || 'diagrama.pdf',
    cachedBatches,
    reportMarkdown
  );
  const effectiveTotalPages = Math.max(
    totalPages,
    reconstructedSheet.totalPages,
    currentPage
  );

  // Automatically build composite PNG + modified PDF blob whenever pageImageUrl or annotations change (skipping while actively dragging a shape)
  useEffect(() => {
    if (isDraggingShape) return;
    let activeModPdfUrl: string | null = null;
    let isCancelled = false;

    const buildCompositeAssets = async () => {
      if (!isOpen) return;
      if (!pageImageUrl && currentPageShapes.length === 0) {
        setAnnotatedPrintDataUrl(null);
        setAnnotatedPdfBlobUrl(null);
        return;
      }

      setIsGeneratingFieldPrint(true);
      try {
        const offCanvas = document.createElement('canvas');
        let imgEl: HTMLImageElement | null = null;

        if (pageImageUrl) {
          imgEl = await new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = pageImageUrl;
          });
        }

        const baseW = imgEl ? Math.max(1200, imgEl.naturalWidth || 1200) : 1400;
        const baseH = imgEl ? Math.max(900, imgEl.naturalHeight || 900) : 1000;
        const headerH = 68;
        offCanvas.width = baseW;
        offCanvas.height = baseH + headerH;

        const ctx = offCanvas.getContext('2d');
        if (!ctx) return;

        // 1. Technical Field Stamp Header
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(0, 0, baseW, headerH);
        ctx.strokeStyle = '#0284C7';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, headerH - 1.5);
        ctx.lineTo(baseW, headerH - 1.5);
        ctx.stroke();

        ctx.fillStyle = '#38BDF8';
        ctx.font =
          'bold 20px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        ctx.textBaseline = 'top';
        const docTitle = activeAttachment?.name || 'DIAGRAMA ELÉTRICO.pdf';
        ctx.fillText(
          `HYDRODIAG AI — FOLHA ANOTADA P/ CAMPO | ${docTitle} (Pág. ${currentPage}/${effectiveTotalPages} · Selo #${reconstructedSheet.folhaSelo})`,
          18,
          12
        );

        ctx.fillStyle = '#F8FAFC';
        ctx.font =
          '15px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        const stampDate = new Date().toLocaleString('pt-BR');
        ctx.fillText(
          `Título: ${reconstructedSheet.tituloFolha} [${reconstructedSheet.tagsPrincipais}]  •  Anotações na folha: ${currentPageShapes.length}  •  Gerado em: ${stampDate}`,
          18,
          40
        );

        // 2. Sheet Body
        ctx.save();
        ctx.translate(0, headerH);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, baseW, baseH);

        if (imgEl) {
          ctx.drawImage(imgEl, 0, 0, baseW, baseH);
        } else {
          // Fallback CAD schematic rendering if vector PDF binary wasn't attached
          ctx.fillStyle = '#F8FAFC';
          ctx.fillRect(0, 0, baseW, baseH);
          ctx.strokeStyle = '#334155';
          ctx.lineWidth = 3;
          ctx.strokeRect(24, 24, baseW - 48, baseH - 48);
          ctx.fillStyle = '#0F172A';
          ctx.font = 'bold 26px ui-monospace, monospace';
          ctx.fillText(
            `FOLHA SELO #${reconstructedSheet.folhaSelo} — ${reconstructedSheet.tituloFolha} (${reconstructedSheet.tagsPrincipais})`,
            48,
            60
          );
          ctx.font = '20px ui-monospace, monospace';
          ctx.fillStyle = '#1E293B';
          ctx.fillText(
            `Bornes e TAGs Mapeados: ${reconstructedSheet.extractedBornesAndTags.join(' · ')}`,
            48,
            115
          );
          reconstructedSheet.reportCitationsForPage.forEach((line, idx) => {
            ctx.fillText(
              `• [Pág. ${currentPage}] ${line.slice(0, 105)}`,
              48,
              175 + idx * 38
            );
          });
        }

        // 3. Draw all circles, arrows, and text callout boxes at full resolution
        for (const shape of currentPageShapes) {
          drawAnnotationShapeOnCtx(ctx, shape, baseW, baseH);
        }
        ctx.restore();

        const pngDataUrl = offCanvas.toDataURL('image/png');
        if (isCancelled) return;
        setAnnotatedPrintDataUrl(pngDataUrl);

        // 4. Generate a single-page modified PDF with annotations baked in via pdf-lib
        if (currentPageShapes.length > 0) {
          const pdfDoc = await PDFDocument.create();
          const pngBytes = await fetch(pngDataUrl).then((r) => r.arrayBuffer());
          const embeddedPng = await pdfDoc.embedPng(pngBytes);
          const page = pdfDoc.addPage([baseW * 0.75, (baseH + headerH) * 0.75]);
          page.drawImage(embeddedPng, {
            x: 0,
            y: 0,
            width: baseW * 0.75,
            height: (baseH + headerH) * 0.75,
          });
          const pdfBytes = await pdfDoc.save();
          const modBlob = new Blob([new Uint8Array(pdfBytes)], {
            type: 'application/pdf',
          });
          activeModPdfUrl = URL.createObjectURL(modBlob);
          if (!isCancelled) {
            setAnnotatedPdfBlobUrl(activeModPdfUrl);
          }
        } else {
          setAnnotatedPdfBlobUrl(null);
        }
      } catch {
        // ignore canvas errors
      } finally {
        if (!isCancelled) {
          setIsGeneratingFieldPrint(false);
        }
      }
    };

    buildCompositeAssets();

    return () => {
      isCancelled = true;
      if (activeModPdfUrl) {
        URL.revokeObjectURL(activeModPdfUrl);
      }
    };
  }, [
    isOpen,
    isDraggingShape,
    pageImageUrl,
    currentPageShapes,
    currentPage,
    effectiveTotalPages,
    activeAttachment?.name,
    reconstructedSheet.folhaSelo,
    reconstructedSheet.tituloFolha,
    reconstructedSheet.tagsPrincipais,
  ]);

  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const applyZoomStep = (deltaFactor: number, clientX?: number, clientY?: number) => {
    const prevZoom = zoomPanRef.current.zoom;
    const prevPanX = zoomPanRef.current.panX;
    const prevPanY = zoomPanRef.current.panY;

    const nextZoom = Math.min(6, Math.max(0.5, Number((prevZoom * deltaFactor).toFixed(3))));
    if (Math.abs(nextZoom - prevZoom) < 0.001) return;

    let nextPanX = prevPanX;
    let nextPanY = prevPanY;

    if (
      viewportRef.current &&
      typeof clientX === 'number' &&
      typeof clientY === 'number'
    ) {
      const rect = viewportRef.current.getBoundingClientRect();
      const cx = clientX - (rect.left + rect.width / 2);
      const cy = clientY - (rect.top + rect.height / 2);
      const ratio = nextZoom / prevZoom;
      nextPanX = cx - (cx - prevPanX) * ratio;
      nextPanY = cy - (cy - prevPanY) * ratio;

      // Keep smooth continuous drag if left mouse button is currently held down ("Mãozinha fechada + Roda")
      dragStartRef.current = {
        startX: clientX,
        startY: clientY,
        originPanX: nextPanX,
        originPanY: nextPanY,
      };
    }

    setZoom(nextZoom);
    setPan({ x: nextPanX, y: nextPanY });
  };

  // Native non-passive wheel listener for smooth Mouse Wheel Zoom (supports Left-Click + Scroll AND Direct Wheel Scroll)
  useEffect(() => {
    const el = viewportRef.current;
    if (!isOpen || !el || useNativeIframe) return;

    let wheelBadgeTimeout: ReturnType<typeof setTimeout> | null = null;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const leftButtonHeld = (e.buttons & 1) === 1 || isDragging;
      if (leftButtonHeld) {
        setIsLeftClickWheelZooming(true);
        if (wheelBadgeTimeout) clearTimeout(wheelBadgeTimeout);
        wheelBadgeTimeout = setTimeout(() => {
          setIsLeftClickWheelZooming(false);
        }, 700);
      }

      const direction = e.deltaY < 0 ? 1 : -1;
      const factor = direction > 0 ? 1.16 : 1 / 1.16;
      applyZoomStep(factor, e.clientX, e.clientY);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (wheelBadgeTimeout) clearTimeout(wheelBadgeTimeout);
      el.removeEventListener('wheel', onWheel);
    };
  }, [isOpen, isLoadingPage, useNativeIframe, isDragging]);

  // Handle ESC key: closes open sub-modals/menus first, then deactivates drawing tool ('circle', 'arrow', 'text') back to 'pan', otherwise closes drawer. Also supports Ctrl+Z to undo and Delete/Backspace to remove selected shape.
  useEffect(() => {
    if (!isOpen) return;

    const focusTimer = setTimeout(() => {
      drawerRef.current?.focus({ preventScroll: true });
    }, 30);

    const focusGuardInterval = setInterval(() => {
      if (
        iframeRef.current &&
        document.activeElement === iframeRef.current
      ) {
        drawerRef.current?.focus({ preventScroll: true });
      }
    }, 250);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (windowState === 'minimized') return;
        e.preventDefault();
        e.stopPropagation();
        if (isFieldPrintModalOpen) {
          setIsFieldPrintModalOpen(false);
          setPrintModalWindowState('normal');
          return;
        }
        if (pendingTextPoint !== null) {
          setPendingTextPoint(null);
          setPendingTextValue('');
          setEditingTextShapeId(null);
          setTextBoxWindowState('normal');
          return;
        }
        if (isAnnotationMenuOpen) {
          setIsAnnotationMenuOpen(false);
          return;
        }
        if (interactionMode !== 'pan' || activeSheetShape !== null) {
          setActiveSheetShape(null);
          setInteractionMode('pan');
          return;
        }
        if (selectedShapeId !== null) {
          setSelectedShapeId(null);
          return;
        }
        onClose();
        return;
      }

      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isTyping =
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        activeTag === 'select';

      if (
        !isTyping &&
        selectedShapeId &&
        (e.key === 'Delete' || e.key === 'Backspace')
      ) {
        e.preventDefault();
        e.stopPropagation();
        const idToRemove = selectedShapeId;
        updateCurrentPageShapes((list) =>
          list.filter((s) => s.id !== idToRemove)
        );
        setSelectedShapeId(null);
        setHoveredShapeId(null);
        return;
      }

      if (
        !isTyping &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'z'
      ) {
        e.preventDefault();
        e.stopPropagation();
        updateCurrentPageShapes((list) =>
          list.length > 0 ? list.slice(0, -1) : list
        );
        return;
      }

      if (!isTyping && !isLoadingPage) {
        if (e.key === 'ArrowLeft' && currentPage > 1) {
          e.preventDefault();
          const prev = Math.max(1, currentPage - 1);
          setCurrentPage(prev);
          setPageInput(String(prev));
        } else if (e.key === 'ArrowRight' && currentPage < effectiveTotalPages) {
          e.preventDefault();
          const next = Math.min(effectiveTotalPages, currentPage + 1);
          setCurrentPage(next);
          setPageInput(String(next));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      clearInterval(focusGuardInterval);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [
    isOpen,
    onClose,
    currentPage,
    effectiveTotalPages,
    isLoadingPage,
    interactionMode,
    activeSheetShape,
    selectedShapeId,
    canonicalPageKey,
    legacyPageKey,
    isFieldPrintModalOpen,
    pendingTextPoint,
    isAnnotationMenuOpen,
    windowState,
  ]);

  useEffect(() => {
    if (isOpen) {
      setWindowState((prev) => (prev === 'minimized' ? 'normal' : prev));
      const targetPage = Math.max(1, initialPage || 1);
      setCurrentPage(targetPage);
      setPageInput(String(targetPage));
      const bestAtt = pickBestAttachmentForPage(
        attachments,
        targetPage,
        initialAttachmentId
      );
      if (bestAtt) {
        setSelectedAttachmentId(bestAtt.id);
      }
    }
  }, [isOpen, initialPage, initialAttachmentId]);

  // Measure viewportRef dynamically so the PDF sheet scales to 100% of the Maximized or Normal window, and detect OS Window Maximize clicks
  useEffect(() => {
    if (!isOpen) return;

    let lastWinW = window.innerWidth;
    let lastWinH = window.innerHeight;

    const updateViewportMetrics = () => {
      const el = viewportRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        setViewportSize({
          width: el.clientWidth,
          height: el.clientHeight,
        });
      }
    };

    updateViewportMetrics();
    const rafId = requestAnimationFrame(updateViewportMetrics);
    const timerId = setTimeout(updateViewportMetrics, 60);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && viewportRef.current) {
      ro = new ResizeObserver(() => {
        updateViewportMetrics();
      });
      ro.observe(viewportRef.current);
    }

    const handleOsWindowResize = () => {
      const curW = window.innerWidth;
      const curH = window.innerHeight;
      const grewSignificantly =
        curW - lastWinW > 80 || curH - lastWinH > 80;
      const isNearFullMonitor =
        typeof window.screen !== 'undefined' &&
        curW >= window.screen.availWidth - 24 &&
        curH >= window.screen.availHeight - 80;

      if (grewSignificantly || (isNearFullMonitor && curW > lastWinW)) {
        setWindowState((prev) => (prev === 'minimized' ? prev : 'maximized'));
      }
      lastWinW = curW;
      lastWinH = curH;
      updateViewportMetrics();
    };

    window.addEventListener('resize', handleOsWindowResize);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleOsWindowResize);
    };
  }, [isOpen, windowState, useNativeIframe, isLoadingPage, showIndexFooter]);

  // Check if any sibling attachment with the same filename already has base64Data
  const siblingWithBase64 = attachments.find(
    (a) =>
      Boolean(a.base64Data) &&
      a.name.trim().toLowerCase() === activeAttachmentNameKey
  );

  const effectiveBase64 = activeAttachment
    ? activeAttachment.base64Data ||
      siblingWithBase64?.base64Data ||
      localRecoveredBase64[activeAttachment.id] ||
      localRecoveredBase64[activeAttachmentNameKey] ||
      ''
    : '';

  useEffect(() => {
    if (!isOpen || !activeAttachment) return;

    let activeUrl: string | null = null;
    let isCancelled = false;

    const loadExtractedPage = async () => {
      setIsLoadingPage(true);

      let b64ToUse = effectiveBase64;
      let justRecoveredFromVault = false;
      if (!b64ToUse) {
        const vaulted = await loadAttachmentBinaryFromVault(activeAttachment);
        if (vaulted && !isCancelled) {
          b64ToUse = vaulted;
          justRecoveredFromVault = true;
          setLocalRecoveredBase64((prev) => ({
            ...prev,
            [activeAttachment.id]: vaulted,
            [activeAttachmentNameKey]: vaulted,
          }));
        }
      }

      if (!b64ToUse) {
        if (!isCancelled) {
          setBlobUrl(null);
          setPageImageUrl(null);
          setTotalPages(reconstructedSheet.totalPages);
          setIsLoadingPage(false);
        }
        return;
      }

      try {
        if (activeAttachment.mimeType !== 'application/pdf') {
          const imgDataUrl = `data:${activeAttachment.mimeType};base64,${b64ToUse}`;
          if (!isCancelled) {
            setBlobUrl(imgDataUrl);
            setPageImageUrl(imgDataUrl);
            setTotalPages(1);
            setCurrentPage(1);
            setPageInput('1');
          }
        } else {
          const result = await extractSinglePdfPageUrl(b64ToUse, currentPage);
          activeUrl = result.blobUrl;

          if (!isCancelled) {
            setBlobUrl(result.blobUrl);
            setPageImageUrl(result.pageImageUrl);
            setTotalPages(result.totalPages);
            if (result.actualPage !== currentPage) {
              setCurrentPage(result.actualPage);
              setPageInput(String(result.actualPage));
            }
          }
        }

        if (
          justRecoveredFromVault &&
          !isCancelled &&
          onRelinkAttachmentBinary
        ) {
          onRelinkAttachmentBinary(
            activeAttachment.id,
            b64ToUse,
            activeAttachment.name,
            activeAttachment.sizeBytes
          );
        }
      } catch {
        if (!isCancelled) {
          setBlobUrl(null);
          setPageImageUrl(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingPage(false);
        }
      }
    };

    loadExtractedPage();

    return () => {
      isCancelled = true;
      if (activeUrl && activeUrl.startsWith('blob:')) {
        URL.revokeObjectURL(activeUrl);
      }
    };
  }, [isOpen, activeAttachmentId, effectiveBase64, currentPage]);

  if (!isOpen) return null;

  const matchingBatch = cachedBatches?.find(
    (b) => currentPage >= b.startPage && currentPage <= b.endPage
  );

  const handleGoToPage = (target: number) => {
    const clamped = Math.min(
      Math.max(1, target),
      Math.max(1, effectiveTotalPages)
    );
    setCurrentPage(clamped);
    setPageInput(String(clamped));
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(pageInput, 10);
    if (!isNaN(parsed)) {
      handleGoToPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleConfirmTextAnnotation = (customText?: string) => {
    const textToUse = (
      typeof customText === 'string' ? customText : pendingTextValue
    ).trim();
    if (!pendingTextPoint || !textToUse) return;

    if (editingTextShapeId) {
      const targetId = editingTextShapeId;
      updateCurrentPageShapes((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? { ...s, text: textToUse, color: annotationColor }
            : s
        )
      );
      setSelectedShapeId(targetId);
      setEditingTextShapeId(null);
      setPendingTextPoint(null);
      setPendingTextValue('');
      return;
    }

    const newTextShape: PhotoAnnotationShape = {
      id: `s_txt_${Date.now()}`,
      tool: 'text',
      color: annotationColor,
      points: [pendingTextPoint],
      text: textToUse,
    };
    updateCurrentPageShapes((prev) => [...prev, newTextShape]);
    setSelectedShapeId(newTextShape.id);
    setPendingTextPoint(null);
    setPendingTextValue('');
  };

  const handlePrintAnnotatedSheetNow = () => {
    document.documentElement.classList.add('printing-pdf-sheet');
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        document.documentElement.classList.remove('printing-pdf-sheet');
      }, 600);
    }, 120);
  };

  const applyActiveShapeDrag = (clientX: number, clientY: number) => {
    const drag = draggingShapeRef.current;
    const canvas = sheetCanvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const normX = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width)
    );
    const normY = Math.min(
      1,
      Math.max(0, (clientY - rect.top) / rect.height)
    );
    const rawDx = normX - drag.startNormX;
    const rawDy = normY - drag.startNormY;

    updateCurrentPageShapes((prevList) =>
      prevList.map((s) => {
        if (s.id !== drag.shapeId) return s;

        if (drag.mode === 'move') {
          const xs = drag.initialPoints.map((p) => p.x);
          const ys = drag.initialPoints.map((p) => p.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);

          const clampedDx = Math.min(1 - maxX, Math.max(-minX, rawDx));
          const clampedDy = Math.min(1 - maxY, Math.max(-minY, rawDy));

          return {
            ...s,
            points: drag.initialPoints.map((p) => ({
              x: Number((p.x + clampedDx).toFixed(4)),
              y: Number((p.y + clampedDy).toFixed(4)),
            })),
          };
        }

        if (drag.mode === 'p0' && drag.initialPoints.length >= 2) {
          const p0 = drag.initialPoints[0];
          const p1 = drag.initialPoints[drag.initialPoints.length - 1];
          return {
            ...s,
            points: [
              {
                x: Number(Math.min(1, Math.max(0, p0.x + rawDx)).toFixed(4)),
                y: Number(Math.min(1, Math.max(0, p0.y + rawDy)).toFixed(4)),
              },
              p1,
            ],
          };
        }

        if (drag.mode === 'p1' && drag.initialPoints.length >= 2) {
          const p0 = drag.initialPoints[0];
          const p1 = drag.initialPoints[drag.initialPoints.length - 1];
          return {
            ...s,
            points: [
              p0,
              {
                x: Number(Math.min(1, Math.max(0, p1.x + rawDx)).toFixed(4)),
                y: Number(Math.min(1, Math.max(0, p1.y + rawDy)).toFixed(4)),
              },
            ],
          };
        }

        if (drag.mode === 'resize-br' && drag.initialPoints.length >= 2) {
          const x1 = Math.min(
            drag.initialPoints[0].x,
            drag.initialPoints[drag.initialPoints.length - 1].x
          );
          const y1 = Math.min(
            drag.initialPoints[0].y,
            drag.initialPoints[drag.initialPoints.length - 1].y
          );
          const x2 = Math.max(
            drag.initialPoints[0].x,
            drag.initialPoints[drag.initialPoints.length - 1].x
          );
          const y2 = Math.max(
            drag.initialPoints[0].y,
            drag.initialPoints[drag.initialPoints.length - 1].y
          );
          return {
            ...s,
            points: [
              { x: x1, y: y1 },
              {
                x: Number(
                  Math.min(1, Math.max(x1 + 0.015, x2 + rawDx)).toFixed(4)
                ),
                y: Number(
                  Math.min(1, Math.max(y1 + 0.015, y2 + rawDy)).toFixed(4)
                ),
              },
            ],
          };
        }

        return s;
      })
    );
  };

  const startDraggingShapeAtClient = (
    shape: PhotoAnnotationShape,
    mode: ShapeDragMode,
    clientX: number,
    clientY: number
  ) => {
    const canvas = sheetCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const normX = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width)
    );
    const normY = Math.min(
      1,
      Math.max(0, (clientY - rect.top) / rect.height)
    );

    setSelectedShapeId(shape.id);
    setHoveredShapeId(shape.id);
    setIsDraggingShape(true);
    draggingShapeRef.current = {
      shapeId: shape.id,
      mode,
      startNormX: normX,
      startNormY: normY,
      initialPoints: shape.points.map((p) => ({ ...p })),
    };
  };

  // Global window listeners so dragging an annotation never drops even if cursor moves fast outside a handle
  useEffect(() => {
    if (!isDraggingShape) return;

    const onWinMouseMove = (e: MouseEvent) => {
      if (!draggingShapeRef.current) return;
      if ((e.buttons & 1) === 0) {
        draggingShapeRef.current = null;
        setIsDraggingShape(false);
        return;
      }
      e.preventDefault();
      applyActiveShapeDrag(e.clientX, e.clientY);
    };

    const onWinMouseUp = () => {
      if (draggingShapeRef.current) {
        draggingShapeRef.current = null;
        setIsDraggingShape(false);
      }
    };

    const onWinTouchMove = (e: TouchEvent) => {
      if (!draggingShapeRef.current || e.touches.length === 0) return;
      e.preventDefault();
      applyActiveShapeDrag(e.touches[0].clientX, e.touches[0].clientY);
    };

    const onWinTouchEnd = () => {
      if (draggingShapeRef.current) {
        draggingShapeRef.current = null;
        setIsDraggingShape(false);
      }
    };

    window.addEventListener('mousemove', onWinMouseMove, { passive: false });
    window.addEventListener('mouseup', onWinMouseUp);
    window.addEventListener('touchmove', onWinTouchMove, { passive: false });
    window.addEventListener('touchend', onWinTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('mouseup', onWinMouseUp);
      window.removeEventListener('touchmove', onWinTouchMove);
      window.removeEventListener('touchend', onWinTouchEnd);
    };
  }, [isDraggingShape]);

  const handleViewportMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || useNativeIframe) return;
    const targetEl = e.target as HTMLElement;
    if (
      targetEl.closest(
        'button, a, input, textarea, select, [data-no-pan="true"]'
      )
    ) {
      return;
    }

    const canvas = sheetCanvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const normX = Math.min(
          1,
          Math.max(0, (e.clientX - rect.left) / rect.width)
        );
        const normY = Math.min(
          1,
          Math.max(0, (e.clientY - rect.top) / rect.height)
        );
        const ctx = canvas.getContext('2d');

        // 1. First check if the user clicked on ANY existing annotation (Circle, Arrow, or Text Box) to move/reposition it!
        if (currentPageShapes.length > 0) {
          const hit = hitTestAnnotationShapes(
            ctx,
            currentPageShapes,
            normX,
            normY,
            canvas.width,
            canvas.height,
            selectedShapeId
          );
          if (hit) {
            e.preventDefault();
            startDraggingShapeAtClient(
              hit.shape,
              hit.mode,
              e.clientX,
              e.clientY
            );
            return;
          }
        }

        // Clicked on empty sheet space -> clear selection
        if (selectedShapeId !== null) {
          setSelectedShapeId(null);
        }

        // 2. If an annotation tool is active, start creating a new shape at (normX, normY)
        if (interactionMode !== 'pan') {
          e.preventDefault();
          if (interactionMode === 'text') {
            setEditingTextShapeId(null);
            setPendingTextPoint({ x: normX, y: normY });
            setPendingTextValue('');
            return;
          }

          setActiveSheetShape({
            id: `s_ann_${Date.now()}`,
            tool: interactionMode === 'circle' ? 'circle' : 'arrow',
            color: annotationColor,
            points: [
              { x: normX, y: normY },
              { x: normX, y: normY },
            ],
          });
          return;
        }
      }
    }

    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
    };
  };

  const handleViewportMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const canvas = sheetCanvasRef.current;

    // 1. Live drag/reposition or endpoint adjustment of an existing Circle, Arrow, or Text Box
    if (draggingShapeRef.current && canvas) {
      if ((e.buttons & 1) === 0) {
        draggingShapeRef.current = null;
        setIsDraggingShape(false);
        return;
      }
      e.preventDefault();
      applyActiveShapeDrag(e.clientX, e.clientY);
      return;
    }

    // 2. Live drawing of a new Circle or Arrow
    if (activeSheetShape && canvas) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        setActiveSheetShape((prev) =>
          prev ? { ...prev, points: [prev.points[0], { x, y }] } : null
        );
      }
      return;
    }

    // 3. Hover detection over existing shapes when not panning
    if (!isDragging && !useNativeIframe && canvas && currentPageShapes.length > 0) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const normX = (e.clientX - rect.left) / rect.width;
        const normY = (e.clientY - rect.top) / rect.height;
        if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
          const ctx = canvas.getContext('2d');
          const hit = hitTestAnnotationShapes(
            ctx,
            currentPageShapes,
            normX,
            normY,
            canvas.width,
            canvas.height,
            selectedShapeId
          );
          const nextHoverId = hit ? hit.shape.id : null;
          if (nextHoverId !== hoveredShapeId) {
            setHoveredShapeId(nextHoverId);
          }
        } else if (hoveredShapeId !== null) {
          setHoveredShapeId(null);
        }
      }
    }

    if (!isDragging || useNativeIframe) return;
    if ((e.buttons & 1) === 0) {
      setIsDragging(false);
      setIsLeftClickWheelZooming(false);
      return;
    }
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    setPan({
      x: dragStartRef.current.originPanX + dx,
      y: dragStartRef.current.originPanY + dy,
    });
  };

  const handleViewportMouseUpOrLeave = () => {
    if (draggingShapeRef.current) {
      draggingShapeRef.current = null;
      setIsDraggingShape(false);
    }
    if (activeSheetShape) {
      const finishedShape = activeSheetShape;
      const p0 = finishedShape.points[0];
      const p1 = finishedShape.points[finishedShape.points.length - 1];
      const dragDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      // Only commit circle/arrow if user actually dragged a meaningful distance (prevents accidental single-click micro-dots)
      if (dragDist >= 0.022) {
        updateCurrentPageShapes((prev) => [...prev, finishedShape]);
        setSelectedShapeId(finishedShape.id);
      }
      setActiveSheetShape(null);
    }
    if (isDragging) {
      setIsDragging(false);
    }
    if (isLeftClickWheelZooming) {
      setIsLeftClickWheelZooming(false);
    }
  };

  const handleViewportDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (useNativeIframe) return;
    const targetEl = e.target as HTMLElement;
    if (
      targetEl.closest(
        'button, a, input, textarea, select, [data-no-pan="true"]'
      )
    ) {
      return;
    }

    // Double-clicking an existing Text Box opens it for editing
    const canvas = sheetCanvasRef.current;
    if (canvas && currentPageShapes.length > 0) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const normX = (e.clientX - rect.left) / rect.width;
        const normY = (e.clientY - rect.top) / rect.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const hit = hitTestAnnotationShapes(
            ctx,
            currentPageShapes,
            normX,
            normY,
            canvas.width,
            canvas.height,
            selectedShapeId
          );
          if (hit && hit.shape.tool === 'text') {
            e.preventDefault();
            setSelectedShapeId(hit.shape.id);
            setEditingTextShapeId(hit.shape.id);
            setAnnotationColor(hit.shape.color);
            setPendingTextPoint(hit.shape.points[0]);
            setPendingTextValue(hit.shape.text || '');
            return;
          }
        }
      }
    }

    if (zoom > 1.35) {
      handleResetView();
    } else {
      applyZoomStep(2.1, e.clientX, e.clientY);
    }
  };

  const zoomPercent = Math.round(zoom * 100);
  const effectivePdfUrlForDownloadOrIframe =
    currentPageShapes.length > 0 && annotatedPdfBlobUrl
      ? annotatedPdfBlobUrl
      : blobUrl;
  const cleanDocBaseName = (activeAttachment?.name || 'diagrama').replace(
    /\.pdf$/i,
    ''
  );

  // Calculate exact pixel box for the PDF sheet so it fills 100% of the available viewport in both Normal and Maximized modes
  const sheetDisplaySize = (() => {
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1440;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 900;
    const fallbackW =
      windowState === 'maximized'
        ? winW - 24
        : Math.min(winW * 0.92, 1152) - 32;
    const fallbackH =
      windowState === 'maximized'
        ? winH - 115
        : winH * 0.88 - 135;

    const rawW = viewportSize.width > 100 ? viewportSize.width : fallbackW;
    const rawH = viewportSize.height > 100 ? viewportSize.height : fallbackH;
    const pad = windowState === 'maximized' ? 12 : 20;
    const availW = Math.max(320, rawW - pad);
    const availH = Math.max(240, rawH - pad);

    const natW = Math.max(1, imgNaturalSize.width || 1600);
    const natH = Math.max(1, imgNaturalSize.height || 1131);
    const aspect = natW / natH;

    if (sheetFitMode === 'width') {
      return {
        width: Math.round(availW),
        height: Math.round(availW / aspect),
      };
    }

    const scale = Math.min(availW / natW, availH / natH);
    return {
      width: Math.max(300, Math.round(natW * scale)),
      height: Math.max(220, Math.round(natH * scale)),
    };
  })();

  const renderInteractiveShapesOverlay = () => {
    if (currentPageShapes.length === 0 || activeSheetShape !== null) {
      return null;
    }

    return (
      <div className="absolute inset-0 pointer-events-none z-30">
        {currentPageShapes.map((s) => {
          const isSelected = selectedShapeId === s.id;
          const isHovered = hoveredShapeId === s.id;

          if (s.tool === 'circle' && s.points.length >= 2) {
            const p0 = s.points[0];
            const p1 = s.points[s.points.length - 1];
            const minX = Math.min(p0.x, p1.x);
            const maxX = Math.max(p0.x, p1.x);
            const minY = Math.min(p0.y, p1.y);
            const maxY = Math.max(p0.y, p1.y);
            const padNorm = 0.008;
            const leftPct = Math.max(0, minX - padNorm) * 100;
            const topPct = Math.max(0, minY - padNorm) * 100;
            const widthPct =
              (Math.min(1, maxX + padNorm) - Math.max(0, minX - padNorm)) * 100;
            const heightPct =
              (Math.min(1, maxY + padNorm) - Math.max(0, minY - padNorm)) * 100;

            return (
              <div
                key={s.id}
                data-shape-id={s.id}
                data-shape-tool="circle"
                data-drag-mode="move"
                data-no-pan="true"
                title="Clique e arraste para mover este círculo"
                onMouseEnter={() => setHoveredShapeId(s.id)}
                onMouseLeave={() => {
                  if (!isDraggingShape) setHoveredShapeId(null);
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  startDraggingShapeAtClient(s, 'move', e.clientX, e.clientY);
                }}
                onTouchStart={(e) => {
                  if (e.touches.length === 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  startDraggingShapeAtClient(
                    s,
                    'move',
                    e.touches[0].clientX,
                    e.touches[0].clientY
                  );
                }}
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${Math.max(2, widthPct)}%`,
                  height: `${Math.max(2, heightPct)}%`,
                }}
                className={`absolute pointer-events-auto cursor-move rounded transition-colors ${
                  isSelected || isHovered
                    ? 'ring-2 ring-sky-400/90 bg-sky-400/5'
                    : 'hover:ring-2 hover:ring-sky-400/80'
                }`}
              >
                {(isSelected || isHovered) && (
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-slate-900/95 border border-sky-400/80 text-[9px] font-mono font-bold text-sky-200 whitespace-nowrap flex items-center gap-1 shadow-lg pointer-events-auto cursor-move">
                    <Move className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                    <span>Arrastar</span>
                  </div>
                )}
                <div
                  data-shape-id={s.id}
                  data-drag-mode="resize-br"
                  data-no-pan="true"
                  title="Arraste para redimensionar o círculo"
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(
                      s,
                      'resize-br',
                      e.clientX,
                      e.clientY
                    );
                  }}
                  onTouchStart={(e) => {
                    if (e.touches.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(
                      s,
                      'resize-br',
                      e.touches[0].clientX,
                      e.touches[0].clientY
                    );
                  }}
                  className={`absolute -bottom-2 -right-2 w-4 h-4 rounded-full bg-sky-500 border-2 border-white shadow cursor-nwse-resize pointer-events-auto ${
                    isSelected || isHovered
                      ? 'opacity-100 scale-100'
                      : 'opacity-0 hover:opacity-100'
                  }`}
                />
              </div>
            );
          }

          if (s.tool === 'arrow' && s.points.length >= 2) {
            const p0 = s.points[0];
            const p1 = s.points[s.points.length - 1];
            const midX = (p0.x + p1.x) / 2;
            const midY = (p0.y + p1.y) / 2;

            return (
              <React.Fragment key={s.id}>
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                >
                  <line
                    x1={p0.x * 1000}
                    y1={p0.y * 1000}
                    x2={p1.x * 1000}
                    y2={p1.y * 1000}
                    stroke="transparent"
                    strokeWidth="36"
                    strokeLinecap="round"
                    data-shape-id={s.id}
                    data-shape-tool="arrow"
                    data-drag-mode="move"
                    data-no-pan="true"
                    style={{ pointerEvents: 'stroke', cursor: 'move' }}
                    onMouseEnter={() => setHoveredShapeId(s.id)}
                    onMouseLeave={() => {
                      if (!isDraggingShape) setHoveredShapeId(null);
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      startDraggingShapeAtClient(
                        s,
                        'move',
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onTouchStart={(e) => {
                      if (e.touches.length === 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      startDraggingShapeAtClient(
                        s,
                        'move',
                        e.touches[0].clientX,
                        e.touches[0].clientY
                      );
                    }}
                  />
                </svg>

                {/* Center drag handle on the arrow shaft */}
                <div
                  data-shape-id={s.id}
                  data-shape-tool="arrow-grip"
                  data-drag-mode="move"
                  data-no-pan="true"
                  title="Clique e arraste para mover esta seta"
                  onMouseEnter={() => setHoveredShapeId(s.id)}
                  onMouseLeave={() => {
                    if (!isDraggingShape) setHoveredShapeId(null);
                  }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(s, 'move', e.clientX, e.clientY);
                  }}
                  onTouchStart={(e) => {
                    if (e.touches.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(
                      s,
                      'move',
                      e.touches[0].clientX,
                      e.touches[0].clientY
                    );
                  }}
                  style={{
                    left: `${midX * 100}%`,
                    top: `${midY * 100}%`,
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-move ${
                    isSelected || isHovered
                      ? 'px-1.5 py-0.5 rounded bg-slate-900/95 border border-sky-400/80 text-[9px] font-mono font-bold text-sky-200 flex items-center gap-1 shadow-lg'
                      : 'w-6 h-6 rounded-full bg-transparent'
                  }`}
                >
                  {(isSelected || isHovered) && (
                    <>
                      <Move className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      <span>Arrastar</span>
                    </>
                  )}
                </div>

                {/* Arrow Tail (p0) and Tip (p1) handles */}
                {(isSelected || isHovered) && (
                  <>
                    <div
                      data-shape-id={s.id}
                      data-drag-mode="p0"
                      data-no-pan="true"
                      title="Arraste para ajustar o início da seta"
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        startDraggingShapeAtClient(
                          s,
                          'p0',
                          e.clientX,
                          e.clientY
                        );
                      }}
                      style={{
                        left: `${p0.x * 100}%`,
                        top: `${p0.y * 100}%`,
                      }}
                      className="absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-sky-500 border-2 border-white shadow cursor-move pointer-events-auto"
                    />
                    <div
                      data-shape-id={s.id}
                      data-drag-mode="p1"
                      data-no-pan="true"
                      title="Arraste para ajustar a ponta da seta"
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        startDraggingShapeAtClient(
                          s,
                          'p1',
                          e.clientX,
                          e.clientY
                        );
                      }}
                      style={{
                        left: `${p1.x * 100}%`,
                        top: `${p1.y * 100}%`,
                      }}
                      className="absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-sky-500 border-2 border-white shadow cursor-move pointer-events-auto"
                    />
                  </>
                )}
              </React.Fragment>
            );
          }

          if (s.tool === 'text' && s.points.length >= 1) {
            const { x1, y1, boxX, boxY, boxW, boxH } =
              getTextAnnotationBoxMetrics(null, s, 1200, 900);
            const leftPct = (boxX / 1200) * 100;
            const topPct = (boxY / 900) * 100;
            const widthPct = (boxW / 1200) * 100;
            const heightPct = (boxH / 900) * 100;

            return (
              <React.Fragment key={s.id}>
                {/* Pin handle */}
                <div
                  data-shape-id={s.id}
                  data-shape-tool="text-pin"
                  data-drag-mode="move"
                  data-no-pan="true"
                  title="Clique e arraste para mover esta anotação de texto"
                  onMouseEnter={() => setHoveredShapeId(s.id)}
                  onMouseLeave={() => {
                    if (!isDraggingShape) setHoveredShapeId(null);
                  }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(s, 'move', e.clientX, e.clientY);
                  }}
                  onTouchStart={(e) => {
                    if (e.touches.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(
                      s,
                      'move',
                      e.touches[0].clientX,
                      e.touches[0].clientY
                    );
                  }}
                  style={{
                    left: `${(x1 / 1200) * 100}%`,
                    top: `${(y1 / 900) * 100}%`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full pointer-events-auto cursor-move"
                />

                {/* Text Box interactive area */}
                <div
                  data-shape-id={s.id}
                  data-shape-tool="text"
                  data-drag-mode="move"
                  data-no-pan="true"
                  title="Clique e arraste para mover esta caixa de texto (Duplo-clique para editar)"
                  onMouseEnter={() => setHoveredShapeId(s.id)}
                  onMouseLeave={() => {
                    if (!isDraggingShape) setHoveredShapeId(null);
                  }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(s, 'move', e.clientX, e.clientY);
                  }}
                  onTouchStart={(e) => {
                    if (e.touches.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    startDraggingShapeAtClient(
                      s,
                      'move',
                      e.touches[0].clientX,
                      e.touches[0].clientY
                    );
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedShapeId(s.id);
                    setEditingTextShapeId(s.id);
                    setAnnotationColor(s.color);
                    setPendingTextPoint(s.points[0]);
                    setPendingTextValue(s.text || '');
                  }}
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    width: `${Math.max(4, widthPct)}%`,
                    height: `${Math.max(3, heightPct)}%`,
                  }}
                  className={`absolute pointer-events-auto cursor-move rounded transition-colors ${
                    isSelected || isHovered
                      ? 'ring-2 ring-sky-400/90 bg-sky-400/5'
                      : 'hover:ring-2 hover:ring-sky-400/80'
                  }`}
                >
                  {(isSelected || isHovered) && (
                    <div className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-slate-900/95 border border-sky-400/80 text-[9px] font-mono font-bold text-sky-200 whitespace-nowrap flex items-center gap-1 shadow-lg pointer-events-auto cursor-move">
                      <Move className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      <span>Arrastar Nota</span>
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          }

          return null;
        })}
      </div>
    );
  };

  const drawerContent = (
    <div
      className={
        windowState === 'minimized'
          ? 'fixed bottom-4 right-4 z-[100] no-print'
          : windowState === 'maximized'
            ? 'fixed inset-0 w-screen h-screen z-[100] bg-[#0B111E] flex items-stretch justify-stretch no-print'
            : 'fixed inset-0 z-[100] bg-black/75 flex items-center justify-center p-2 sm:p-4 no-print'
      }
    >
      {/* Dedicated Full-Sheet Print Surface when user clicks "Imprimir Folha c/ Anotações Agora" */}
      {annotatedPrintDataUrl && (
        <div className="hidden pdf-field-print-sheet">
          <img
            src={annotatedPrintDataUrl}
            alt={`Folha ${currentPage} Anotada para Campo`}
            className="w-full h-auto object-contain block"
          />
        </div>
      )}

      {/* Backdrop click to close when in normal windowed mode */}
      {windowState !== 'minimized' && (
        <div
          className="fixed inset-0 -z-10 cursor-pointer no-print-when-sheet"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Floating Minimized Taskbar Dock when Window is Minimized */}
      {windowState === 'minimized' && (
        <div className="bg-[#111827] border-2 border-sky-500/70 rounded-xl shadow-2xl px-3.5 py-2.5 flex items-center gap-3 max-w-[95vw] sm:max-w-xl backdrop-blur-md">
          <div
            onClick={() => setWindowState('normal')}
            className="flex items-center gap-2.5 min-w-0 cursor-pointer group"
            title="Clique para restaurar a janela do Inspetor de Diagrama PDF"
          >
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/40 flex items-center justify-center text-sky-400 shrink-0 group-hover:bg-sky-500/30 transition-colors">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-white truncate">
                  {activeAttachment?.name || 'Diagrama PDF'}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 text-[10px] font-mono text-sky-300 shrink-0">
                  Pág. {currentPage}/{effectiveTotalPages}
                </span>
                {currentPageShapes.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-rose-500/25 border border-rose-500/40 text-[10px] font-mono text-rose-200 shrink-0">
                    {currentPageShapes.length} anot.
                  </span>
                )}
              </div>
              <p className="text-[10px] font-mono text-slate-400 truncate">
                Janela minimizada • Folha #{reconstructedSheet.folhaSelo} (Zoom{' '}
                {zoomPercent}%)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 border-l border-slate-700 pl-2.5">
            <button
              type="button"
              onClick={() => setWindowState('normal')}
              className="px-2.5 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-mono font-semibold flex items-center gap-1 cursor-pointer transition-colors"
              title="Restaurar janela ao tamanho normal"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Restaurar</span>
            </button>
            <button
              type="button"
              onClick={() => setWindowState('maximized')}
              className="p-1.5 rounded-md bg-slate-800 hover:bg-sky-600/30 border border-slate-700 hover:border-sky-500/50 text-slate-200 hover:text-white cursor-pointer transition-colors"
              title="Maximizar janela em Tela Cheia"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md bg-slate-800 hover:bg-rose-600/40 border border-slate-700 hover:border-rose-500/60 text-slate-300 hover:text-white cursor-pointer transition-colors"
              title="Fechar janela (ESC)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Hidden input for attaching raw vector PDF anytime */}
      <input
        ref={quickRelinkInputRef}
        type="file"
        accept=".pdf,application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file || !activeAttachment) return;
          setIsLoadingPage(true);
          const reader = new FileReader();
          reader.onload = async () => {
            const result = String(reader.result || '');
            const b64 = result.includes(',') ? result.split(',')[1] : result;
            if (b64) {
              await saveAttachmentBinaryToVault({
                id: activeAttachment.id,
                name: activeAttachment.name,
                sizeBytes: activeAttachment.sizeBytes || file.size,
                base64Data: b64,
              });
              if (
                file.name.trim().toLowerCase() !== activeAttachmentNameKey
              ) {
                await saveAttachmentBinaryToVault({
                  id: activeAttachment.id,
                  name: file.name,
                  sizeBytes: file.size,
                  base64Data: b64,
                });
              }
              setLocalRecoveredBase64((prev) => ({
                ...prev,
                [activeAttachment.id]: b64,
                [activeAttachmentNameKey]: b64,
                [file.name.trim().toLowerCase()]: b64,
              }));
              if (onRelinkAttachmentBinary) {
                onRelinkAttachmentBinary(
                  activeAttachment.id,
                  b64,
                  file.name,
                  file.size
                );
              }
            }
            setIsLoadingPage(false);
          };
          reader.onerror = () => setIsLoadingPage(false);
          reader.readAsDataURL(file);
          e.target.value = '';
        }}
      />

      {/* Inspector Window Panel (Supports Normal Windowed, Maximized Fullscreen, and Hidden when Minimized) */}
      <aside
        ref={drawerRef}
        tabIndex={-1}
        onMouseMove={() => {
          if (
            document.activeElement &&
            document.activeElement === iframeRef.current
          ) {
            drawerRef.current?.focus();
          }
        }}
        aria-label="Visualizador Interativo de Folha do PDF (Deep-Link)"
        className={
          windowState === 'minimized'
            ? 'hidden'
            : windowState === 'maximized'
              ? 'w-screen h-screen max-w-none max-h-none rounded-none border-0 bg-[#0B111E] flex flex-col shadow-2xl overflow-hidden focus:outline-none no-print-when-sheet'
              : 'w-[92vw] max-w-6xl h-[88vh] rounded-xl bg-[#0B111E] border border-slate-700 flex flex-col shadow-2xl overflow-hidden focus:outline-none no-print-when-sheet'
        }
      >
        {/* Top Control Bar (Double-click toggles Maximize/Restore) */}
        <div
          onDoubleClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('button, a, input, select, form')) return;
            setWindowState((prev) =>
              prev === 'maximized' ? 'normal' : 'maximized'
            );
          }}
          className="px-4 py-2.5 bg-[#111827] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0 select-none"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-md bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-100 truncate">
                  Inspetor Deep-Link de Diagrama Elétrico
                </h3>
                <span className="text-xs font-mono tabular-nums text-sky-400 shrink-0">
                  Página {currentPage} de {effectiveTotalPages}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                Folha Selo #{reconstructedSheet.folhaSelo} —{' '}
                {reconstructedSheet.tituloFolha} (
                <code>{reconstructedSheet.tagsPrincipais}</code>)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Selector if multiple PDFs are attached */}
            {attachments.length > 1 && (
              <select
                aria-label="Selecionar Arquivo PDF da Sequência"
                value={activeAttachment?.id || ''}
                onChange={(e) => {
                  setSelectedAttachmentId(e.target.value);
                  setCurrentPage(1);
                  setPageInput('1');
                }}
                className="bg-[#0B111E] border border-slate-700 text-slate-200 text-xs font-mono rounded-md px-2.5 py-1.5 focus:outline-none focus:border-sky-500 max-w-[220px] truncate cursor-pointer"
              >
                {attachments.map((att) => (
                  <option key={att.id} value={att.id}>
                    #{att.sequenceIndex} {att.name} ({att.categoryTag})
                  </option>
                ))}
              </select>
            )}

            {/* Page Navigation Controls */}
            <div className="flex items-center gap-1 bg-[#0B111E] border border-slate-800 rounded-md p-1">
              <button
                type="button"
                disabled={currentPage <= 1 || isLoadingPage}
                onClick={() => handleGoToPage(currentPage - 1)}
                className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 rounded cursor-pointer"
                title="Página Anterior (Seta Esquerda)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              <form
                onSubmit={handlePageInputSubmit}
                className="flex items-center gap-1 px-1"
              >
                <span className="text-[11px] text-slate-400">Pág.</span>
                <input
                  type="text"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={handlePageInputSubmit}
                  aria-label="Número da página do PDF"
                  className="w-11 text-center bg-[#111827] border border-slate-700 focus:border-sky-500 rounded py-0.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none"
                />
                <span className="text-[11px] font-mono tabular-nums text-slate-400">
                  / {effectiveTotalPages}
                </span>
              </form>

              <button
                type="button"
                disabled={currentPage >= effectiveTotalPages || isLoadingPage}
                onClick={() => handleGoToPage(currentPage + 1)}
                className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 rounded cursor-pointer"
                title="Próxima Página (Seta Direita)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {effectivePdfUrlForDownloadOrIframe && (
              <a
                href={effectivePdfUrlForDownloadOrIframe}
                download={`${cleanDocBaseName}_Pagina_${currentPage}${currentPageShapes.length > 0 ? '_Anotada_Campo' : ''}.pdf`}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors cursor-pointer"
                title={
                  currentPageShapes.length > 0
                    ? 'Baixar esta folha em PDF já com todas as suas anotações gravadas'
                    : 'Baixar apenas esta folha recortada em PDF'
                }
              >
                <Download className="w-3.5 h-3.5 text-sky-400" />
                <span className="hidden sm:inline">
                  {currentPageShapes.length > 0
                    ? `Baixar PDF Anotado (${currentPageShapes.length})`
                    : 'Baixar Folha'}
                </span>
              </a>
            )}

            {onAskAboutCurrentPage && activeAttachment && (
              <button
                type="button"
                onClick={() => {
                  onAskAboutCurrentPage(currentPage, activeAttachment.name);
                  onClose();
                }}
                className="px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Perguntar ao Engenheiro Eletricista no Chat sobre os bornes desta página"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Perguntar sobre Pág. {currentPage}</span>
              </button>
            )}

            {/* Window Controls Group: Minimizar, Maximizar/Restaurar, Fechar */}
            <div className="flex items-center gap-1 bg-[#0B111E] border border-slate-700 rounded-lg p-1 ml-1">
              <button
                type="button"
                onClick={() => setWindowState('minimized')}
                className="px-2.5 py-1 text-xs font-mono text-slate-200 hover:text-white hover:bg-slate-800 rounded transition-colors cursor-pointer flex items-center gap-1"
                title="Minimizar janela para o rodapé (permite ler o Laudo e usar o Chat sem perder a folha aberta)"
              >
                <Minus className="w-3.5 h-3.5 text-amber-400" />
                <span>Minimizar</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setWindowState((prev) => {
                    const next = prev === 'maximized' ? 'normal' : 'maximized';
                    try {
                      localStorage.setItem('hydrodiag_pdf_window_mode_v1', next);
                    } catch {
                      // ignore
                    }
                    return next;
                  });
                }}
                className={`px-2.5 py-1 text-xs font-mono font-semibold rounded transition-colors cursor-pointer flex items-center gap-1 ${
                  windowState === 'maximized'
                    ? 'bg-sky-500/25 border border-sky-500/50 text-sky-200 hover:bg-sky-500/35'
                    : 'bg-sky-600/20 border border-sky-500/40 text-sky-200 hover:bg-sky-500/30 hover:text-white'
                }`}
                title={
                  windowState === 'maximized'
                    ? 'Restaurar tamanho normal da janela'
                    : 'Maximizar janela em Tela Cheia (100%)'
                }
              >
                {windowState === 'maximized' ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5 text-sky-300" />
                    <span>Restaurar</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5 text-sky-300" />
                    <span>Maximizar</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={onClose}
                className="px-2.5 py-1 text-xs font-mono text-slate-200 hover:text-white hover:bg-rose-600/35 rounded transition-colors cursor-pointer flex items-center gap-1"
                title="Fechar janela (Tecla Esc)"
              >
                <X className="w-3.5 h-3.5 text-rose-400" />
                <span>Fechar</span>
              </button>
            </div>
          </div>
        </div>

        {/* Interactive CAD Pan ("Mãozinha"), Grouped Annotation Menu & Field Print Control Bar */}
        <div className="px-4 py-2 bg-[#0D1526] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* 1. Mãozinha (Pan) */}
            <button
              type="button"
              onClick={() => {
                setActiveSheetShape(null);
                setPendingTextPoint(null);
                setInteractionMode('pan');
              }}
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium flex items-center gap-1.5 border transition-colors cursor-pointer ${
                interactionMode === 'pan'
                  ? isDragging || isLeftClickWheelZooming
                    ? 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                    : 'bg-sky-500/20 border-sky-500/50 text-sky-200 font-semibold'
                  : 'bg-[#0B111E] border-slate-700 text-slate-300 hover:text-white'
              }`}
              title="Modo Mãozinha (CAD Pan): Clique esq. e arraste para mover a folha; Clique esq. + Roda para Zoom (Atalho: Tecla ESC quando estiver desenhando)"
            >
              {isDragging ? (
                <Grab className="w-3.5 h-3.5 text-amber-300" />
              ) : (
                <Hand className="w-3.5 h-3.5 text-sky-400" />
              )}
              <span>
                {isLeftClickWheelZooming
                  ? 'Mãozinha + Roda: Zoom Ativo'
                  : isDragging
                    ? 'Arrastando Folha...'
                    : 'Mãozinha (Pan)'}
              </span>
              {interactionMode !== 'pan' && (
                <span className="ml-0.5 px-1 py-0.2 rounded bg-slate-800 border border-slate-600 text-[9px] text-sky-300">
                  ESC
                </span>
              )}
            </button>

            {/* 2. Grouped Annotation Dropdown Menu ("Menu com a setinha": Círculo, Seta e Caixa de Texto) */}
            <div ref={annotationMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setIsAnnotationMenuOpen((prev) => !prev)}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium flex items-center gap-1.5 border transition-colors cursor-pointer ${
                  interactionMode !== 'pan'
                    ? 'bg-rose-500/25 border-rose-500 text-rose-100 font-semibold shadow-sm'
                    : 'bg-[#0B111E] border-slate-700 text-slate-200 hover:text-white hover:border-slate-500'
                }`}
                title="Abrir menu de ferramentas de anotação no PDF (Circular Borne, Seta Indicadora e Caixa de Texto)"
              >
                {interactionMode === 'circle' ? (
                  <>
                    <Circle
                      className="w-3.5 h-3.5"
                      style={{ color: annotationColor }}
                    />
                    <span>Circular Borne</span>
                  </>
                ) : interactionMode === 'arrow' ? (
                  <>
                    <MoveUpRight
                      className="w-3.5 h-3.5"
                      style={{ color: annotationColor }}
                    />
                    <span>Seta Indicadora</span>
                  </>
                ) : interactionMode === 'text' ? (
                  <>
                    <Type
                      className="w-3.5 h-3.5"
                      style={{ color: annotationColor }}
                    />
                    <span>Caixa de Texto</span>
                  </>
                ) : (
                  <>
                    <Pencil className="w-3.5 h-3.5 text-rose-400" />
                    <span>Anotar no PDF</span>
                  </>
                )}
                <span
                  className="w-2 h-2 rounded-full border border-white/40"
                  style={{ backgroundColor: annotationColor }}
                />
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                    isAnnotationMenuOpen ? 'rotate-180 text-white' : ''
                  }`}
                />
              </button>

              {isAnnotationMenuOpen && (
                <div
                  data-no-pan="true"
                  className="absolute left-0 mt-1.5 w-72 rounded-lg bg-[#0F172A] border border-slate-700 shadow-2xl p-1.5 z-50 space-y-1"
                >
                  <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 border-b border-slate-800 flex items-center justify-between">
                    <span>Ferramentas de Marcação</span>
                    <span className="text-sky-400">ESC desativa</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setUseNativeIframe(false);
                      setInteractionMode('circle');
                      setPendingTextPoint(null);
                      setIsAnnotationMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-md text-xs font-mono flex items-center justify-between transition-colors cursor-pointer ${
                      interactionMode === 'circle'
                        ? 'bg-rose-500/20 border border-rose-500/50 text-white font-semibold'
                        : 'text-slate-200 hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Circle
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: annotationColor }}
                      />
                      <span>
                        <strong className="block">Circular Borne</strong>
                        <span className="text-[10px] text-slate-400 font-sans">
                          Arraste p/ criar • Clique e arraste p/ mover
                        </span>
                      </span>
                    </span>
                    {interactionMode === 'circle' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/30 text-rose-200">
                        Ativo
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setUseNativeIframe(false);
                      setInteractionMode('arrow');
                      setPendingTextPoint(null);
                      setIsAnnotationMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-md text-xs font-mono flex items-center justify-between transition-colors cursor-pointer ${
                      interactionMode === 'arrow'
                        ? 'bg-rose-500/20 border border-rose-500/50 text-white font-semibold'
                        : 'text-slate-200 hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <MoveUpRight
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: annotationColor }}
                      />
                      <span>
                        <strong className="block">Seta Indicadora</strong>
                        <span className="text-[10px] text-slate-400 font-sans">
                          Apontar medição • Clique e arraste p/ mover
                        </span>
                      </span>
                    </span>
                    {interactionMode === 'arrow' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/30 text-rose-200">
                        Ativo
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setUseNativeIframe(false);
                      setInteractionMode('text');
                      setIsAnnotationMenuOpen(false);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-md text-xs font-mono flex items-center justify-between transition-colors cursor-pointer ${
                      interactionMode === 'text'
                        ? 'bg-rose-500/20 border border-rose-500/50 text-white font-semibold'
                        : 'text-slate-200 hover:bg-slate-800/80'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Type
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: annotationColor }}
                      />
                      <span>
                        <strong className="block">
                          Caixa de Texto (Anotação)
                        </strong>
                        <span className="text-[10px] text-slate-400 font-sans">
                          Escrever nota • Clique e arraste p/ mover
                        </span>
                      </span>
                    </span>
                    {interactionMode === 'text' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/30 text-rose-200">
                        Ativo
                      </span>
                    )}
                  </button>

                  {/* Color Picker inside dropdown */}
                  <div className="pt-1.5 mt-1 border-t border-slate-800 px-2 py-1">
                    <span className="text-[10px] font-mono text-slate-400 block mb-1.5">
                      Cor da Marcação / Texto:
                    </span>
                    <div className="flex items-center gap-1.5">
                      {PDF_ANNOTATION_COLORS.map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => {
                            setAnnotationColor(c.hex);
                            if (selectedShapeId) {
                              updateCurrentPageShapes((list) =>
                                list.map((s) =>
                                  s.id === selectedShapeId
                                    ? { ...s, color: c.hex }
                                    : s
                                )
                              );
                            }
                          }}
                          className={`flex-1 py-1 px-1.5 rounded border text-[10px] font-mono flex items-center justify-center gap-1 cursor-pointer ${
                            annotationColor === c.hex
                              ? 'bg-slate-800 border-white text-white font-semibold'
                              : 'bg-slate-900/70 border-slate-700 text-slate-400 hover:text-white'
                          }`}
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: c.hex }}
                          />
                          <span className="truncate">
                            {c.label.split(' ')[0]}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 3. Desfazer (Undo) */}
            <button
              type="button"
              disabled={currentPageShapes.length === 0}
              onClick={() =>
                updateCurrentPageShapes((list) =>
                  list.length > 0 ? list.slice(0, -1) : list
                )
              }
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium flex items-center gap-1 border transition-colors ${
                currentPageShapes.length > 0
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-200 cursor-pointer'
                  : 'bg-[#0B111E] border-slate-800 text-slate-500 opacity-50 cursor-not-allowed'
              }`}
              title="Desfazer última marcação feita nesta página (Atalho: Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5 text-amber-400" />
              <span>Desfazer</span>
            </button>

            {/* 3.5 Selected Shape Contextual Actions (Move / Edit Text / Delete Single Shape) */}
            {selectedShape && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/50 text-[11px] font-mono text-sky-200">
                <Move className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="hidden md:inline">
                  {selectedShape.tool === 'circle'
                    ? 'Círculo'
                    : selectedShape.tool === 'arrow'
                      ? 'Seta'
                      : 'Caixa de Texto'}{' '}
                  (arraste p/ mover)
                </span>
                {selectedShape.tool === 'text' && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTextShapeId(selectedShape.id);
                      setAnnotationColor(selectedShape.color);
                      setPendingTextPoint(selectedShape.points[0]);
                      setPendingTextValue(selectedShape.text || '');
                    }}
                    className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/25 hover:bg-amber-500/40 border border-amber-400/50 text-amber-200 flex items-center gap-1 cursor-pointer"
                    title="Editar o texto desta anotação (ou dê duplo-clique na caixa)"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                    <span>Editar</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const idToRemove = selectedShape.id;
                    updateCurrentPageShapes((list) =>
                      list.filter((s) => s.id !== idToRemove)
                    );
                    setSelectedShapeId(null);
                    setHoveredShapeId(null);
                  }}
                  className="ml-1 px-1.5 py-0.5 rounded bg-rose-500/25 hover:bg-rose-500/45 border border-rose-500/50 text-rose-200 flex items-center gap-1 cursor-pointer"
                  title="Excluir apenas esta marcação selecionada (Atalho: Delete)"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                  <span>Excluir</span>
                </button>
              </div>
            )}

            {/* 4. Limpar */}
            {currentPageShapes.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  updateCurrentPageShapes(() => []);
                  setSelectedShapeId(null);
                  setHoveredShapeId(null);
                }}
                className="px-2 py-1 rounded text-[11px] font-mono bg-rose-950/60 hover:bg-rose-900/60 border border-rose-700/50 text-rose-200 flex items-center gap-1 cursor-pointer"
                title="Limpar todas as marcações desta página"
              >
                <Trash2 className="w-3 h-3" />
                <span>Limpar ({currentPageShapes.length})</span>
              </button>
            )}

            {/* 5. Gerar Print / PDF Modificado c/ Anotações para Campo */}
            <button
              type="button"
              onClick={() => setIsFieldPrintModalOpen(true)}
              className={`px-2.5 py-1 rounded text-xs font-mono font-semibold flex items-center gap-1.5 border transition-colors cursor-pointer ${
                currentPageShapes.length > 0
                  ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/60 text-emerald-200 shadow-sm'
                  : 'bg-sky-500/15 hover:bg-sky-500/25 border-sky-500/40 text-sky-200'
              }`}
              title="Gerar Print e PDF modificado com todas as anotações gravadas para imprimir e levar para o campo"
            >
              <Printer className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Print p/ Campo
                {currentPageShapes.length > 0
                  ? ` (${currentPageShapes.length})`
                  : ''}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center bg-[#0B111E] border border-slate-700 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => applyZoomStep(1 / 1.25)}
                className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 rounded cursor-pointer"
                title="Diminuir Zoom"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={handleResetView}
                className="px-2 py-0.5 text-xs font-mono tabular-nums font-semibold text-sky-300 hover:text-white cursor-pointer"
                title="Clique para voltar a 100% e centralizar"
              >
                {zoomPercent}%
              </button>

              <button
                type="button"
                onClick={() => applyZoomStep(1.25)}
                className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 rounded cursor-pointer"
                title="Aumentar Zoom"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setSheetFitMode((prev) =>
                  prev === 'contain' ? 'width' : 'contain'
                );
                setPan({ x: 0, y: 0 });
              }}
              className={`px-2 py-1 text-xs font-mono border rounded flex items-center gap-1 cursor-pointer transition-colors ${
                sheetFitMode === 'width'
                  ? 'bg-sky-500/25 border-sky-500/60 text-sky-200 font-semibold'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300 hover:text-white'
              }`}
              title="Alternar entre Ajustar Folha Inteira na Tela e Preencher 100% da Largura da Tela"
            >
              <Maximize2 className="w-3 h-3 text-sky-400" />
              <span>
                {sheetFitMode === 'width' ? 'Ajustar Folha' : 'Largura 100%'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleResetView}
              className="px-2 py-1 text-xs font-mono text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1 cursor-pointer"
              title="Centralizar e Resetar Zoom (100%)"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden sm:inline">Centralizar</span>
            </button>

            {effectivePdfUrlForDownloadOrIframe &&
              activeAttachment?.mimeType === 'application/pdf' && (
                <button
                  type="button"
                  onClick={() => setUseNativeIframe((prev) => !prev)}
                  className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white bg-[#111827] hover:bg-slate-800 border border-slate-700 rounded cursor-pointer"
                  title="Alternar entre o Canvas Interativo (Mãozinha + Anotações) e o Leitor PDF Nativo do Navegador (já com as anotações embutidas)"
                >
                  {useNativeIframe ? 'Usar Mãozinha (CAD)' : 'PDF Nativo'}
                </button>
              )}
          </div>
        </div>

        {/* Helper Banner when Caixa de Texto mode is active */}
        {interactionMode === 'text' && !pendingTextPoint && (
          <div className="px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-xs font-mono text-amber-200 flex items-center justify-between gap-2 shrink-0">
            <span className="flex items-center gap-2">
              <Type className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                <strong>Modo Caixa de Texto ativo:</strong> Clique em qualquer
                ponto vazio da folha para digitar uma nota, ou{' '}
                <strong>clique e arraste</strong> qualquer círculo, seta ou
                caixa de texto existente para movê-la.
              </span>
            </span>
            <button
              type="button"
              onClick={() => setInteractionMode('pan')}
              className="px-2 py-0.5 rounded bg-slate-900/80 border border-amber-500/40 text-[11px] text-amber-300 hover:text-white cursor-pointer"
            >
              Sair (ESC)
            </button>
          </div>
        )}

        {/* Main Interactive Pan & Zoom Viewport */}
        <div
          className={`flex-1 min-h-0 min-w-0 bg-[#070B14] ${
            windowState === 'maximized' ? 'p-1' : 'p-2 sm:p-3'
          } overflow-hidden flex flex-col relative`}
        >
          {/* Floating Text Box Input Window when user clicks a point on the sheet in 'text' mode or edits an existing text box */}
          {pendingTextPoint && (
            <div
              data-no-pan="true"
              className={`absolute z-40 rounded-xl bg-[#0F172A]/95 border-2 border-amber-500/70 shadow-2xl backdrop-blur-md transition-all ${
                textBoxWindowState === 'minimized'
                  ? 'bottom-3 right-3 w-auto max-w-md p-2.5'
                  : textBoxWindowState === 'maximized'
                    ? 'top-3 left-1/2 -translate-x-1/2 w-[96%] max-w-3xl p-4 space-y-3'
                    : 'top-4 left-1/2 -translate-x-1/2 w-[94%] max-w-lg p-3.5 space-y-2.5'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  onClick={() => {
                    if (textBoxWindowState === 'minimized') {
                      setTextBoxWindowState('normal');
                    }
                  }}
                  className="text-xs font-mono font-semibold text-amber-300 flex items-center gap-1.5 cursor-pointer"
                >
                  <Type className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    {editingTextShapeId
                      ? `Editar Caixa de Texto (Pág. ${currentPage})`
                      : `Inserir Caixa de Texto (Pág. ${currentPage})`}
                  </span>
                </span>

                {/* Window Controls for Text Box Floating Window */}
                <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-700 rounded-md p-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setTextBoxWindowState((prev) =>
                        prev === 'minimized' ? 'normal' : 'minimized'
                      )
                    }
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
                    title={
                      textBoxWindowState === 'minimized'
                        ? 'Restaurar janela de texto'
                        : 'Minimizar janela de texto para ver o circuito atrás'
                    }
                  >
                    <Minus className="w-3 h-3 text-amber-400" />
                    <span className="hidden sm:inline">
                      {textBoxWindowState === 'minimized'
                        ? 'Restaurar'
                        : 'Minimizar'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setTextBoxWindowState((prev) =>
                        prev === 'maximized' ? 'normal' : 'maximized'
                      )
                    }
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-300 hover:text-white hover:bg-sky-500/20 flex items-center gap-1 cursor-pointer"
                    title={
                      textBoxWindowState === 'maximized'
                        ? 'Restaurar tamanho padrão'
                        : 'Maximizar caixa de edição de texto'
                    }
                  >
                    {textBoxWindowState === 'maximized' ? (
                      <>
                        <Minimize2 className="w-3 h-3 text-sky-400" />
                        <span className="hidden sm:inline">Restaurar</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3 h-3 text-sky-400" />
                        <span className="hidden sm:inline">Maximizar</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setEditingTextShapeId(null);
                      setPendingTextPoint(null);
                      setPendingTextValue('');
                      setTextBoxWindowState('normal');
                    }}
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-300 hover:text-white hover:bg-rose-600/35 flex items-center gap-1 cursor-pointer"
                    title="Fechar caixa de texto (ESC)"
                  >
                    <X className="w-3 h-3 text-rose-400" />
                    <span className="hidden sm:inline">Fechar</span>
                  </button>
                </div>
              </div>

              {textBoxWindowState !== 'minimized' && (
                <>
                  {/* Quick field note chips */}
                  <div className="flex flex-wrap gap-1">
                    {QUICK_PDF_TEXT_NOTES.map((note) => (
                      <button
                        key={note}
                        type="button"
                        onClick={() => handleConfirmTextAnnotation(note)}
                        className="px-2 py-1 rounded bg-slate-800/90 hover:bg-sky-500/20 border border-slate-700 hover:border-sky-500/50 text-[11px] font-mono text-slate-200 hover:text-sky-200 transition-colors cursor-pointer"
                        title="Clique para inserir esta nota imediatamente"
                      >
                        + {note}
                      </button>
                    ))}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleConfirmTextAnnotation();
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      type="text"
                      autoFocus
                      value={pendingTextValue}
                      onChange={(e) => setPendingTextValue(e.target.value)}
                      placeholder="Digite sua anotação técnica (ex: Medir 125Vcc no borne X3:56)..."
                      className="flex-1 bg-[#090D16] border border-slate-700 focus:border-amber-400 rounded-lg px-3 py-1.5 text-xs font-mono text-white focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!pendingTextValue.trim()}
                      className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-mono font-bold text-xs cursor-pointer shrink-0"
                    >
                      {editingTextShapeId ? 'Salvar Nota' : 'Fixar Nota'}
                    </button>
                  </form>
                </>
              )}
            </div>
          )}

          {isLoadingPage && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-300">
              <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
              <p className="text-xs font-mono">
                Carregando Página {currentPage} de {effectiveTotalPages}...
              </p>
            </div>
          )}

          {/* Optional Native Browser PDF Plugin Mode (Uses Annotated PDF Blob if annotations exist!) */}
          {!isLoadingPage &&
            effectivePdfUrlForDownloadOrIframe &&
            useNativeIframe &&
            activeAttachment?.mimeType === 'application/pdf' && (
              <div className="flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
                <iframe
                  ref={iframeRef}
                  key={`${activeAttachment.id}_p_${currentPage}_ann_${currentPageShapes.length}`}
                  title={`Página ${currentPage} - ${activeAttachment.name}`}
                  src={`${effectivePdfUrlForDownloadOrIframe}#toolbar=1&navpanes=0&view=FitH`}
                  className="w-full h-full flex-1 border-0"
                />
              </div>
            )}

          {/* Interactive CAD Pan ("Mãozinha") & Mouse Wheel Zoom Surface */}
          {!isLoadingPage &&
            !(
              effectivePdfUrlForDownloadOrIframe &&
              useNativeIframe &&
              activeAttachment?.mimeType === 'application/pdf'
            ) && (
              <div
                ref={viewportRef}
                onMouseDown={handleViewportMouseDown}
                onMouseMove={handleViewportMouseMove}
                onMouseUp={handleViewportMouseUpOrLeave}
                onMouseLeave={handleViewportMouseUpOrLeave}
                onDoubleClick={handleViewportDoubleClick}
                style={{
                  cursor:
                    isDraggingShape || hoveredShapeId
                      ? 'move'
                      : interactionMode !== 'pan'
                        ? 'crosshair'
                        : isDragging
                          ? 'grabbing'
                          : 'grab',
                }}
                className={`flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-slate-800 bg-[#050912] relative select-none ${
                  isDraggingShape || hoveredShapeId
                    ? 'cursor-move'
                    : interactionMode !== 'pan'
                      ? 'cursor-crosshair'
                      : isDragging
                        ? 'cursor-grabbing'
                        : 'cursor-grab'
                }`}
              >
                {/* Transformed Pan + Zoom Layer */}
                <div
                  style={{
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isDragging
                      ? 'none'
                      : 'transform 60ms cubic-bezier(0.2, 0, 0, 1)',
                  }}
                  className={`w-full h-full flex-1 min-h-0 min-w-0 flex ${
                    sheetFitMode === 'width' ? 'items-start' : 'items-center'
                  } justify-center p-1 sm:p-2`}
                >
                  {pageImageUrl ? (
                    <div
                      style={{
                        width: `${sheetDisplaySize.width}px`,
                        height: `${sheetDisplaySize.height}px`,
                      }}
                      className="relative shrink-0 rounded shadow-2xl bg-white select-none"
                    >
                      <img
                        src={pageImageUrl}
                        alt={`Página ${currentPage} - ${activeAttachment?.name || 'Diagrama'}`}
                        draggable={false}
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                            setImgNaturalSize({
                              width: el.naturalWidth,
                              height: el.naturalHeight,
                            });
                          }
                        }}
                        className="w-full h-full object-fill rounded pointer-events-none select-none block"
                      />
                      <canvas
                        ref={sheetCanvasRef}
                        width={1200}
                        height={900}
                        className="absolute inset-0 w-full h-full pointer-events-none"
                      />
                      {renderInteractiveShapesOverlay()}
                    </div>
                  ) : (
                    /* Interactive Reconstructed CAD Sheet inside the Pan/Zoom surface (also supports annotations!) */
                    <div
                      className={`relative w-full ${
                        windowState === 'maximized'
                          ? 'max-w-none h-full'
                          : 'max-w-5xl'
                      } rounded-lg border border-sky-900/70 bg-[#080D1A] shadow-2xl overflow-hidden flex flex-col`}
                    >
                      <canvas
                        ref={sheetCanvasRef}
                        width={1200}
                        height={900}
                        className="absolute inset-0 w-full h-full pointer-events-none z-20"
                      />
                      {renderInteractiveShapesOverlay()}
                      {/* Top CAD Frame Coordinate Ruler (Colunas 1 - 8) */}
                      <div className="grid grid-cols-8 border-b border-slate-800 bg-[#0D1526] text-[10px] font-mono text-slate-400 text-center shrink-0">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((col) => {
                          const isHighlightedCol =
                            reconstructedSheet.extractedCoordinates.some((c) =>
                              c.includes(String(col))
                            );
                          return (
                            <div
                              key={col}
                              className={`py-1 border-r last:border-r-0 border-slate-800 ${
                                isHighlightedCol
                                  ? 'bg-amber-500/20 text-amber-300 font-bold'
                                  : ''
                              }`}
                            >
                              COLUNA {col}
                            </div>
                          );
                        })}
                      </div>

                      {/* Sub-header banner with CAD Sheet Info & Optional Vector PDF Attach */}
                      <div className="px-4 py-2.5 bg-[#111827]/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[11px] font-mono font-semibold text-sky-300">
                            FOLHA SELO #{reconstructedSheet.folhaSelo}
                          </span>
                          <span className="text-xs font-semibold text-slate-100">
                            {reconstructedSheet.tituloFolha}
                          </span>
                          <span className="text-xs font-mono text-amber-400">
                            [{reconstructedSheet.tagsPrincipais}]
                          </span>
                        </div>

                        <button
                          type="button"
                          data-no-pan="true"
                          onClick={() => quickRelinkInputRef.current?.click()}
                          className="px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:text-white bg-sky-500/15 hover:bg-sky-600 border border-sky-500/30 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                          title="Carregar arquivo PDF original do computador para ver o desenho vetorial bruto"
                        >
                          <Upload className="w-3 h-3" />
                          <span>Abrir PDF Vetorial Original</span>
                        </button>
                      </div>

                      {/* Main CAD Blueprint Schematic Body */}
                      <div className="p-4 sm:p-5 flex flex-col gap-4 justify-between">
                        {/* 1. Extracted Coordinates & Terminal Blocks Bar */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="p-3.5 rounded-lg bg-[#0D1526] border border-slate-800 flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-mono uppercase tracking-wider text-sky-400 font-semibold flex items-center gap-1.5">
                                <Cpu className="w-3.5 h-3.5" />
                                Bornes, Réguas e TAGs na Página {currentPage}
                              </span>
                              <span className="text-[11px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded">
                                {reconstructedSheet.extractedCoordinates.join(
                                  ' · '
                                )}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {reconstructedSheet.extractedBornesAndTags.map(
                                (token, idx) => (
                                  <span
                                    key={idx}
                                    className="px-2.5 py-1 rounded bg-[#111827] border border-sky-500/30 text-xs font-mono font-semibold text-slate-100"
                                  >
                                    {token}
                                  </span>
                                )
                              )}
                            </div>
                          </div>

                          <div className="p-3.5 rounded-lg bg-[#0D1526] border border-slate-800 flex flex-col justify-between gap-2">
                            <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 font-semibold flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Topologia Funcional da Folha #
                              {reconstructedSheet.folhaSelo}
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono text-slate-200">
                              <span className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-sky-300">
                                {reconstructedSheet.tagsPrincipais}
                              </span>
                              <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                              <span className="px-2 py-1 rounded bg-slate-900 border border-amber-500/40 text-amber-300">
                                {reconstructedSheet.tituloFolha}
                              </span>
                              <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                              <span className="px-2 py-1 rounded bg-slate-900 border border-emerald-500/40 text-emerald-300">
                                Pág. {currentPage} / {effectiveTotalPages}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* 2. Technical Points & Citations Mapped to This Page */}
                        <div className="p-4 rounded-lg bg-[#0D1526] border border-slate-800 space-y-2.5">
                          <h4 className="text-xs font-mono uppercase tracking-wider text-slate-300 font-semibold flex items-center gap-2">
                            <FileText className="w-3.5 h-3.5 text-sky-400" />
                            <span>
                              Pontos de Inspeção e Circuitos Mapeados na Página{' '}
                              {currentPage} (Folha{' '}
                              {reconstructedSheet.folhaSelo})
                            </span>
                          </h4>
                          <ul className="space-y-2 text-xs text-slate-200 leading-relaxed">
                            {reconstructedSheet.reportCitationsForPage.map(
                              (line, idx) => (
                                <li
                                  key={idx}
                                  className="p-2.5 rounded bg-[#111827] border border-slate-800/90 flex items-start gap-2.5"
                                >
                                  <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-mono text-[10px] font-bold shrink-0 mt-0.5">
                                    PÁG. {currentPage}
                                  </span>
                                  <span>{line}</span>
                                </li>
                              )
                            )}
                          </ul>
                        </div>

                        {/* 3. Interactive Sheet Navigator for Current Caderno Batch (e.g. Pages 41-50) */}
                        {reconstructedSheet.batchPages.length > 0 && (
                          <div
                            data-no-pan="true"
                            className="p-3.5 rounded-lg bg-[#0D1526] border border-slate-800 space-y-2"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5 text-sky-400" />
                                Folhas do Caderno neste Lote (Clique para abrir
                                a folha)
                              </span>
                              <span className="text-[11px] font-mono text-slate-400">
                                Total: {effectiveTotalPages} páginas indexadas
                              </span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto pr-1">
                              {reconstructedSheet.batchPages.map((entry) => {
                                const isCurrent = entry.pdfPage === currentPage;
                                return (
                                  <button
                                    key={entry.pdfPage}
                                    type="button"
                                    data-no-pan="true"
                                    onClick={() => handleGoToPage(entry.pdfPage)}
                                    className={`text-left px-2.5 py-1.5 rounded border text-xs font-mono transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                                      isCurrent
                                        ? 'bg-sky-500/20 border-sky-500 text-white font-semibold'
                                        : 'bg-[#111827] border-slate-800 text-slate-300 hover:border-slate-700 hover:text-white'
                                    }`}
                                  >
                                    <span className="truncate">
                                      <strong className="text-sky-400">
                                        Pág. {entry.pdfPage}
                                      </strong>{' '}
                                      (Selo {entry.folhaSelo}) — {entry.titulo}
                                    </span>
                                    <span className="text-[10px] text-amber-400 shrink-0">
                                      {entry.tags}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* 4. Official ABNT Engineering Title Block (Selo Técnico no Canto Inferior Direito) */}
                        <div className="mt-auto pt-1 flex justify-end">
                          <div className="w-full sm:w-[440px] border-2 border-slate-700 bg-[#0B111E] rounded grid grid-cols-3 text-[11px] font-mono text-slate-200">
                            <div className="col-span-2 p-2 border-b border-r border-slate-700">
                              <div className="text-[9px] text-slate-400 uppercase">
                                CADERNO / ARQUIVO TÉCNICO
                              </div>
                              <div className="font-semibold text-slate-100 truncate">
                                {activeAttachment?.name ||
                                  'UNIFILAR GERADORES.pdf'}
                              </div>
                            </div>
                            <div className="p-2 border-b border-slate-700">
                              <div className="text-[9px] text-slate-400 uppercase">
                                PAINEL / TAG
                              </div>
                              <div className="font-semibold text-amber-400 truncate">
                                {reconstructedSheet.tagsPrincipais}
                              </div>
                            </div>
                            <div className="col-span-2 p-2 border-r border-slate-700">
                              <div className="text-[9px] text-slate-400 uppercase">
                                TÍTULO DA FOLHA NO SELO
                              </div>
                              <div className="font-semibold text-sky-300 truncate">
                                {reconstructedSheet.tituloFolha}
                              </div>
                            </div>
                            <div className="p-2 flex items-center justify-between">
                              <div>
                                <div className="text-[9px] text-slate-400 uppercase">
                                  FOLHA SELO
                                </div>
                                <div className="font-bold text-white">
                                  #{reconstructedSheet.folhaSelo}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-[9px] text-slate-400 uppercase">
                                  PÁG. PDF
                                </div>
                                <div className="font-bold text-sky-400">
                                  {currentPage}/{effectiveTotalPages}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
        </div>

        {/* Footer with Cached Index Summary for the Inspected Batch (Compact/Collapsible so PDF has maximum vertical height) */}
        {matchingBatch && (
          <div className="px-4 py-1.5 bg-[#111827] border-t border-slate-800 text-xs text-slate-300 flex items-center justify-between gap-3 shrink-0">
            <div className="min-w-0 flex-1 flex items-center gap-2">
              <span className="font-mono text-[11px] text-sky-400 font-semibold shrink-0">
                Índice Técnico (Págs. {matchingBatch.startPage}–
                {matchingBatch.endPage}):
              </span>
              <span
                className={`text-slate-400 text-[11px] ${
                  showIndexFooter ? '' : 'truncate'
                }`}
              >
                {matchingBatch.summary}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowIndexFooter((prev) => !prev)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-slate-300 hover:text-white shrink-0 cursor-pointer"
            >
              {showIndexFooter ? 'Recolher Índice' : 'Expandir Índice'}
            </button>
          </div>
        )}
      </aside>

      {/* Modal: Print de Campo / PDF Modificado com as Anotações */}
      {isFieldPrintModalOpen && (
        <div
          data-no-pan="true"
          className={
            printModalWindowState === 'minimized'
              ? 'fixed bottom-4 left-4 z-[60] no-print-when-sheet'
              : printModalWindowState === 'maximized'
                ? 'fixed inset-0 z-[60] bg-black/90 flex items-center justify-center no-print-when-sheet'
                : 'fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-3 sm:p-6 no-print-when-sheet'
          }
        >
          <div
            className={
              printModalWindowState === 'minimized'
                ? 'bg-[#111827] border-2 border-emerald-500/70 rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3'
                : printModalWindowState === 'maximized'
                  ? 'w-screen h-screen bg-[#0B111E] flex flex-col overflow-hidden'
                  : 'w-full max-w-4xl max-h-[92vh] bg-[#0B111E] border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden'
            }
          >
            {/* Modal Header */}
            <div
              className={
                printModalWindowState === 'minimized'
                  ? 'flex items-center justify-between gap-4'
                  : 'px-4 py-3 bg-[#111827] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3'
              }
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                  <Printer className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">
                    Print de Campo — Folha Modificada com Anotações (Pág.{' '}
                    {currentPage})
                  </h4>
                  {printModalWindowState !== 'minimized' && (
                    <p className="text-[11px] text-slate-400">
                      Suas marcações ({currentPageShapes.length}) ficam salvas
                      automaticamente nesta folha e já estão gravadas no Print e
                      no PDF abaixo.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {printModalWindowState !== 'minimized' && (
                  <>
                    <button
                      type="button"
                      onClick={handlePrintAnnotatedSheetNow}
                      className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-semibold flex items-center gap-1.5 cursor-pointer shadow"
                      title="Abrir janela de impressão da folha com todas as anotações para levar ao campo"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Imprimir p/ Campo Agora</span>
                    </button>

                    {(annotatedPdfBlobUrl || blobUrl) && (
                      <a
                        href={annotatedPdfBlobUrl || blobUrl || '#'}
                        download={`${cleanDocBaseName}_Folha_${currentPage}_Anotada_Campo.pdf`}
                        className="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-mono font-semibold flex items-center gap-1.5 cursor-pointer shadow"
                        title="Baixar arquivo PDF modificado contendo a folha e todas as anotações desenhadas"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Baixar PDF Modificado (.pdf)</span>
                      </a>
                    )}

                    {annotatedPrintDataUrl && (
                      <a
                        href={annotatedPrintDataUrl}
                        download={`${cleanDocBaseName}_Folha_${currentPage}_Print_Campo.png`}
                        className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
                        title="Baixar imagem PNG em alta resolução com carimbo técnico e anotações"
                      >
                        <Download className="w-3.5 h-3.5 text-amber-400" />
                        <span>Baixar Imagem Print (.png)</span>
                      </a>
                    )}
                  </>
                )}

                {/* Window Controls for Print Modal: Minimizar, Maximizar/Restaurar, Fechar */}
                <div className="flex items-center gap-1 bg-[#0B111E] border border-slate-700 rounded-lg p-1">
                  <button
                    type="button"
                    onClick={() =>
                      setPrintModalWindowState((prev) =>
                        prev === 'minimized' ? 'normal' : 'minimized'
                      )
                    }
                    className="px-2 py-1 rounded text-xs font-mono text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
                    title={
                      printModalWindowState === 'minimized'
                        ? 'Restaurar janela de Print'
                        : 'Minimizar janela de Print'
                    }
                  >
                    <Minus className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden sm:inline">
                      {printModalWindowState === 'minimized'
                        ? 'Restaurar'
                        : 'Minimizar'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setPrintModalWindowState((prev) =>
                        prev === 'maximized' ? 'normal' : 'maximized'
                      )
                    }
                    className="px-2 py-1 rounded text-xs font-mono text-slate-300 hover:text-white hover:bg-sky-500/20 flex items-center gap-1 cursor-pointer"
                    title={
                      printModalWindowState === 'maximized'
                        ? 'Restaurar tamanho normal'
                        : 'Maximizar visualização em Tela Cheia'
                    }
                  >
                    {printModalWindowState === 'maximized' ? (
                      <>
                        <Minimize2 className="w-3.5 h-3.5 text-sky-400" />
                        <span className="hidden sm:inline">Restaurar</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3.5 h-3.5 text-sky-400" />
                        <span className="hidden sm:inline">Maximizar</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setIsFieldPrintModalOpen(false);
                      setPrintModalWindowState('normal');
                    }}
                    className="px-2 py-1 rounded text-xs font-mono text-slate-300 hover:text-white hover:bg-rose-600/35 flex items-center gap-1 cursor-pointer"
                    title="Fechar visualização (ESC)"
                  >
                    <X className="w-3.5 h-3.5 text-rose-400" />
                    <span className="hidden sm:inline">Fechar</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Preview Body */}
            {printModalWindowState !== 'minimized' && (
              <div className="flex-1 overflow-y-auto p-4 bg-[#060A12] flex flex-col items-center justify-center">
                {isGeneratingFieldPrint ? (
                  <div className="py-16 flex flex-col items-center gap-3 text-slate-300">
                    <Loader2 className="w-7 h-7 text-emerald-400 animate-spin" />
                    <p className="text-xs font-mono">
                      Gerando folha de alta resolução com as anotações
                      gravadas...
                    </p>
                  </div>
                ) : annotatedPrintDataUrl ? (
                  <div className="w-full flex flex-col items-center gap-3">
                    <img
                      src={annotatedPrintDataUrl}
                      alt={`Print de Campo - Página ${currentPage}`}
                      className={`max-w-full ${
                        printModalWindowState === 'maximized'
                          ? 'max-h-[82vh]'
                          : 'max-h-[70vh]'
                      } object-contain rounded-lg border border-slate-700 shadow-2xl bg-white`}
                    />
                    <p className="text-[11px] font-mono text-slate-400 text-center">
                      Acima está o print exato com cabeçalho técnico de campo e
                      todas as marcações (círculos, setas e caixas de texto)
                      incorporadas na imagem e no PDF.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs font-mono text-slate-400 py-12">
                    Nenhuma visualização disponível para esta folha.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(drawerContent, document.body)
    : drawerContent;
};
