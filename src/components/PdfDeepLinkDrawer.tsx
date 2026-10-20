import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { DiagramAttachment } from '../types';
import {
  extractSinglePdfPageUrl,
  getCachedPdfIndex,
} from '../utils/pdfClientEngine';

interface PdfDeepLinkDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  attachments: DiagramAttachment[];
  initialPage: number;
  initialAttachmentId?: string;
  onAskAboutCurrentPage?: (pageNumber: number, attachmentName: string) => void;
  onRequestReupload?: () => void;
}

export const PdfDeepLinkDrawer: React.FC<PdfDeepLinkDrawerProps> = ({
  isOpen,
  onClose,
  attachments,
  initialPage,
  initialAttachmentId,
  onAskAboutCurrentPage,
  onRequestReupload,
}) => {
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
  const [isLoadingPage, setIsLoadingPage] = useState<boolean>(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const targetPage = Math.max(1, initialPage || 1);
      setCurrentPage(targetPage);
      setPageInput(String(targetPage));
      if (initialAttachmentId) {
        setSelectedAttachmentId(initialAttachmentId);
      } else if (
        !selectedAttachmentId ||
        !attachments.some((a) => a.id === selectedAttachmentId)
      ) {
        const firstWithData =
          attachments.find((a) => Boolean(a.base64Data)) || attachments[0];
        if (firstWithData) {
          setSelectedAttachmentId(firstWithData.id);
        }
      }
    }
  }, [isOpen, initialPage, initialAttachmentId, attachments]);

  const activeAttachment =
    attachments.find((a) => a.id === selectedAttachmentId) || attachments[0];

  useEffect(() => {
    if (!isOpen || !activeAttachment) return;

    let activeUrl: string | null = null;
    let isCancelled = false;

    const loadExtractedPage = async () => {
      if (!activeAttachment.base64Data) {
        setBlobUrl(null);
        setPageError(
          'Este diagnóstico foi reaberto do histórico na nuvem. Para visualizar o desenho em tela cheia neste computador, selecione novamente o arquivo PDF na caixa de Upload.'
        );
        return;
      }

      setIsLoadingPage(true);
      setPageError(null);

      try {
        if (activeAttachment.mimeType !== 'application/pdf') {
          const imgDataUrl = `data:${activeAttachment.mimeType};base64,${activeAttachment.base64Data}`;
          if (!isCancelled) {
            setBlobUrl(imgDataUrl);
            setTotalPages(1);
            setCurrentPage(1);
            setPageInput('1');
          }
          return;
        }

        const result = await extractSinglePdfPageUrl(
          activeAttachment.base64Data,
          currentPage
        );
        activeUrl = result.blobUrl;

        if (!isCancelled) {
          setBlobUrl(result.blobUrl);
          setTotalPages(result.totalPages);
          if (result.actualPage !== currentPage) {
            setCurrentPage(result.actualPage);
            setPageInput(String(result.actualPage));
          }
        }
      } catch {
        if (!isCancelled) {
          setPageError(
            'Não foi possível extrair esta folha do PDF. Verifique se o arquivo é um PDF válido.'
          );
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
  }, [isOpen, activeAttachment, currentPage]);

  if (!isOpen) return null;

  // Lookup cached AI summary for the current page if available
  const cachedBatches = activeAttachment
    ? getCachedPdfIndex(activeAttachment)
    : null;
  const matchingBatch = cachedBatches?.find(
    (b) => currentPage >= b.startPage && currentPage <= b.endPage
  );

  const handleGoToPage = (target: number) => {
    const clamped = Math.min(Math.max(1, target), Math.max(1, totalPages));
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

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex justify-end no-print">
      {/* Backdrop click to close */}
      <div
        className="flex-1 cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Inspector Panel */}
      <aside
        aria-label="Visualizador Interativo de Folha do PDF (Deep-Link)"
        className="w-full max-w-4xl bg-[#0B111E] border-l border-slate-800 h-full flex flex-col shadow-2xl"
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
                  Página {currentPage} de {totalPages}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">
                Recorte cirúrgico em alta resolução para conferência de bornes (
                <code>/EL</code>, <code>/RB</code>, <code>/ME</code>,{' '}
                <code>/RM</code>)
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
                title="Página Anterior"
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
                  / {totalPages}
                </span>
              </form>

              <button
                type="button"
                disabled={currentPage >= totalPages || isLoadingPage}
                onClick={() => handleGoToPage(currentPage + 1)}
                className="p-1 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40 rounded cursor-pointer"
                title="Próxima Página"
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
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
              title="Fechar Inspetor (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main PDF Single-Page High-Speed Canvas */}
        <div className="flex-1 bg-[#0B111E] p-3 sm:p-4 overflow-hidden flex flex-col relative">
          {isLoadingPage && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-300">
              <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
              <p className="text-xs font-mono">
                Recortando Página {currentPage} em alta resolução...
              </p>
            </div>
          )}

          {!isLoadingPage && pageError && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 max-w-md mx-auto gap-4">
              <div className="w-12 h-12 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <FileText className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h4 className="text-sm font-semibold text-slate-100">
                  Arquivo PDF Local Não Carregado Nesta Sessão
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {pageError}
                </p>
              </div>
              {onRequestReupload && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onRequestReupload();
                  }}
                  className="px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-2 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Abrir Painel de Upload para Anexar o PDF</span>
                </button>
              )}
            </div>
          )}

          {!isLoadingPage && !pageError && blobUrl && (
            <div className="flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
              {activeAttachment?.mimeType === 'application/pdf' ? (
                <iframe
                  key={`${activeAttachment.id}_p_${currentPage}`}
                  title={`Página ${currentPage} - ${activeAttachment.name}`}
                  src={`${blobUrl}#toolbar=1&navpanes=0&view=FitH`}
                  className="w-full h-full flex-1 border-0"
                />
              ) : (
                <div className="flex-1 overflow-auto flex items-center justify-center p-4">
                  <img
                    src={blobUrl}
                    alt={activeAttachment?.name || 'Foto de campo'}
                    className="max-h-full max-w-full object-contain rounded"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Optional Footer with Cached Index Summary for the Inspected Batch */}
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
