import React, { useEffect, useRef, useState } from 'react';
import {
  FileText,
  ChevronLeft,
  ChevronRight,
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
} from 'lucide-react';
import { DiagramAttachment } from '../types';
import {
  extractReconstructedPageSheetData,
  extractSinglePdfPageUrl,
  getCachedPdfIndex,
  loadAttachmentBinaryFromVault,
  saveAttachmentBinaryToVault,
} from '../utils/pdfClientEngine';

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

  // CAD Pan ("Mãozinha") & Mouse Wheel Zoom State
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isLeftClickWheelZooming, setIsLeftClickWheelZooming] =
    useState<boolean>(false);

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

  // Reset Pan & Zoom when switching pages or files
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);
    setIsLeftClickWheelZooming(false);
  }, [currentPage, activeAttachmentId, isOpen]);

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

  // Close drawer with ESC key (and navigate pages with ArrowLeft / ArrowRight when not typing in input)
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
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isTyping =
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        activeTag === 'select';

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
  }, [isOpen, onClose, currentPage, effectiveTotalPages, isLoadingPage]);

  useEffect(() => {
    if (isOpen) {
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

  const handleViewportMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || useNativeIframe) return;
    const targetEl = e.target as HTMLElement;
    if (targetEl.closest('button, a, input, select, [data-no-pan="true"]')) {
      return;
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
    if (targetEl.closest('button, a, input, select, [data-no-pan="true"]')) {
      return;
    }
    if (zoom > 1.35) {
      handleResetView();
    } else {
      applyZoomStep(2.1, e.clientX, e.clientY);
    }
  };

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex justify-end no-print">
      {/* Backdrop click to close */}
      <div
        className="flex-1 cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

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

      {/* Slide-over Inspector Panel */}
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
        className="w-full max-w-5xl bg-[#0B111E] border-l border-slate-800 h-full flex flex-col shadow-2xl focus:outline-none"
      >
        {/* Top Control Bar */}
        <div className="px-4 py-3 bg-[#111827] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
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

            {blobUrl && (
              <a
                href={blobUrl}
                download={`${(activeAttachment?.name || 'diagrama').replace(/\.pdf$/i, '')}_Pagina_${currentPage}.pdf`}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Baixar apenas esta folha recortada em PDF"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" />
                <span className="hidden sm:inline">Baixar Folha</span>
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

            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1.5 text-slate-300 hover:text-white bg-slate-800/80 hover:bg-rose-600/30 border border-slate-700 hover:border-rose-500/50 rounded-md transition-colors cursor-pointer flex items-center gap-1"
              title="Fechar Inspetor (Tecla Esc)"
            >
              <span className="text-[10px] font-mono text-slate-400">ESC</span>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Interactive CAD Pan ("Mãozinha") & Mouse Wheel Zoom Control Bar */}
        <div className="px-4 py-2 bg-[#0D1526] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium flex items-center gap-1.5 border transition-colors ${
                isDragging || isLeftClickWheelZooming
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                  : 'bg-sky-500/15 border-sky-500/30 text-sky-300'
              }`}
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
                    ? 'Mãozinha Fechada: Arrastando Página...'
                    : 'Modo Pan (Mãozinha): Clique esq. p/ arrastar · Clique esq. + Rolar p/ Zoom'}
              </span>
            </span>
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
              onClick={handleResetView}
              className="px-2 py-1 text-xs font-mono text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1 cursor-pointer"
              title="Centralizar e Resetar Zoom (100%)"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden sm:inline">Centralizar</span>
            </button>

            {blobUrl && activeAttachment?.mimeType === 'application/pdf' && (
              <button
                type="button"
                onClick={() => setUseNativeIframe((prev) => !prev)}
                className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white bg-[#111827] hover:bg-slate-800 border border-slate-700 rounded cursor-pointer"
                title="Alternar entre o Canvas Interativo (Mãozinha + Zoom) e o Leitor PDF Nativo do Navegador"
              >
                {useNativeIframe ? 'Usar Mãozinha (CAD)' : 'PDF Nativo'}
              </button>
            )}
          </div>
        </div>

        {/* Main Interactive Pan & Zoom Viewport */}
        <div className="flex-1 bg-[#070B14] p-2 sm:p-3 overflow-hidden flex flex-col relative">
          {isLoadingPage && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-300">
              <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
              <p className="text-xs font-mono">
                Carregando Página {currentPage} de {effectiveTotalPages}...
              </p>
            </div>
          )}

          {/* Optional Native Browser PDF Plugin Mode */}
          {!isLoadingPage &&
            blobUrl &&
            useNativeIframe &&
            activeAttachment?.mimeType === 'application/pdf' && (
              <div className="flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
                <iframe
                  ref={iframeRef}
                  key={`${activeAttachment.id}_p_${currentPage}`}
                  title={`Página ${currentPage} - ${activeAttachment.name}`}
                  src={`${blobUrl}#toolbar=1&navpanes=0&view=FitH`}
                  className="w-full h-full flex-1 border-0"
                />
              </div>
            )}

          {/* Interactive CAD Pan ("Mãozinha") & Mouse Wheel Zoom Surface */}
          {!isLoadingPage &&
            !(
              blobUrl &&
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
                  cursor: isDragging ? 'grabbing' : 'grab',
                }}
                className={`flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-slate-800 bg-[#050912] relative select-none ${
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
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
                  className="w-full h-full flex-1 flex items-center justify-center p-2 sm:p-4"
                >
                  {pageImageUrl ? (
                    <img
                      src={pageImageUrl}
                      alt={`Página ${currentPage} - ${activeAttachment?.name || 'Diagrama'}`}
                      draggable={false}
                      className="max-h-full max-w-full object-contain rounded shadow-2xl bg-white pointer-events-none select-none"
                    />
                  ) : (
                    /* Interactive Reconstructed CAD Sheet inside the Pan/Zoom surface */
                    <div className="w-full max-w-4xl rounded-lg border border-sky-900/70 bg-[#080D1A] shadow-2xl overflow-hidden flex flex-col">
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

        {/* Footer with Cached Index Summary for the Inspected Batch */}
        {matchingBatch && (
          <div className="px-4 py-2.5 bg-[#111827] border-t border-slate-800 text-xs text-slate-300 flex items-start justify-between gap-3 shrink-0">
            <div className="min-w-0 flex-1">
              <span className="font-mono text-[11px] text-sky-400 font-semibold">
                Índice Técnico (Págs. {matchingBatch.startPage}–
                {matchingBatch.endPage}):{' '}
              </span>
              <span className="text-slate-400 text-[11px] line-clamp-2">
                {matchingBatch.summary}
              </span>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
};
