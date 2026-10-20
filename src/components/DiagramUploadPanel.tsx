import React, { useEffect, useRef, useState } from 'react';
import {
  FileText,
  Image as ImageIcon,
  Upload,
  PlusCircle,
  Trash2,
  Eye,
  Link2,
  X,
  ArrowRightCircle,
} from 'lucide-react';
import { DiagramAttachment, DiagramCategoryTag } from '../types';

interface DiagramUploadPanelProps {
  attachments: DiagramAttachment[];
  onAddAttachments: (
    files: FileList,
    isSequentialNext: boolean,
    defaultCategory?: DiagramCategoryTag,
    panelHint?: string,
    customSequenceNote?: string
  ) => Promise<void>;
  onContinueSamePdfInSequence?: (customNote: string) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onUpdateCategory: (id: string, category: DiagramCategoryTag) => void;
  onUpdatePanelName: (id: string, panelName: string) => void;
  isUploading: boolean;
  sequenceModalOpen: boolean;
  setSequenceModalOpen: (open: boolean) => void;
}

const CATEGORY_OPTIONS: DiagramCategoryTag[] = [
  '/EL',
  '/RB',
  '/ME',
  '/RM',
  'FOTO CAMPO',
];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export const DiagramUploadPanel: React.FC<DiagramUploadPanelProps> = ({
  attachments,
  onAddAttachments,
  onContinueSamePdfInSequence,
  onRemoveAttachment,
  onUpdateCategory,
  onUpdatePanelName,
  isUploading,
  sequenceModalOpen,
  setSequenceModalOpen,
}) => {
  const initialInputRef = useRef<HTMLInputElement | null>(null);
  const sequenceInputRef = useRef<HTMLInputElement | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [seqPanelName, setSeqPanelName] = useState('');
  const [seqCategory, setSeqCategory] = useState<DiagramCategoryTag>('/EL');
  const [seqNote, setSeqNote] = useState('');
  const [previewAttachment, setPreviewAttachment] =
    useState<DiagramAttachment | null>(null);

  useEffect(() => {
    if (!sequenceModalOpen && !previewAttachment) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        if (previewAttachment) {
          setPreviewAttachment(null);
        } else if (sequenceModalOpen) {
          setSequenceModalOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [sequenceModalOpen, previewAttachment, setSequenceModalOpen]);

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await onAddAttachments(e.dataTransfer.files, false);
    }
  };

  const handleInitialFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (e.target.files && e.target.files.length > 0) {
      await onAddAttachments(e.target.files, false);
      e.target.value = '';
    }
  };

  const handleSequenceFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const selectedFiles = e.target.files;
    if (selectedFiles && selectedFiles.length > 0) {
      const panelToUse = seqPanelName.trim() || undefined;
      const noteToUse = seqNote.trim() || undefined;
      const categoryToUse = seqCategory;

      // Close modal immediately so the user sees the live analysis starting right away
      setSequenceModalOpen(false);
      setSeqPanelName('');
      setSeqNote('');

      await onAddAttachments(
        selectedFiles,
        true,
        categoryToUse,
        panelToUse,
        noteToUse
      );
      e.target.value = '';
    }
  };

  const handleSamePdfSequenceClick = async () => {
    if (!onContinueSamePdfInSequence) return;
    const note =
      seqNote.trim() ||
      (seqPanelName.trim()
        ? `Analisar na sequência: ${seqPanelName.trim()} (${seqCategory})`
        : 'Analise na sequência a próxima folha/diagrama indicado na seção 5 do diagnóstico anterior e detalhe os bornes e procedimento.');
    setSequenceModalOpen(false);
    setSeqPanelName('');
    setSeqNote('');
    await onContinueSamePdfInSequence(note);
  };

  return (
    <section
      aria-label="Caixa de Upload de Diagramas"
      className="bg-[#111827] border border-slate-800 rounded-lg p-4 flex flex-col gap-3"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            1. Upload de Diagramas (PDF ou Foto)
          </h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Cadernos <code className="text-sky-300">/EL</code> · Bornes{' '}
            <code className="text-sky-300">/RB</code> · Mecânico{' '}
            <code className="text-sky-300">/ME</code> · Materiais{' '}
            <code className="text-sky-300">/RM</code>
          </p>
        </div>
        <span className="text-[11px] font-mono tabular-nums text-sky-400 shrink-0">
          {attachments.length}{' '}
          {attachments.length === 1 ? 'arquivo' : 'arquivos'}
        </span>
      </div>

      {/* Compact Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border border-dashed rounded-lg p-3 transition-colors flex flex-col items-center justify-center text-center gap-2 ${
          isDragging
            ? 'border-sky-400 bg-sky-500/10'
            : 'border-slate-700 bg-[#0B111E]/70 hover:border-slate-600'
        }`}
      >
        <input
          ref={initialInputRef}
          type="file"
          multiple
          accept=".pdf,application/pdf,image/jpeg,image/png,image/webp"
          onChange={handleInitialFileChange}
          className="hidden"
        />

        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-sky-400 shrink-0" />
          <p className="text-xs font-medium text-slate-200">
            Arraste PDFs ou fotos de painéis aqui
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <button
            type="button"
            disabled={isUploading}
            onClick={() => initialInputRef.current?.click()}
            className="px-3 py-1.5 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {isUploading ? 'Sincronizando...' : 'Selecionar PDF / Foto'}
          </button>

          <button
            type="button"
            disabled={isUploading}
            onClick={() => setSequenceModalOpen(true)}
            className="px-2.5 py-1.5 text-xs font-medium text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 rounded-md transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>+ Na Sequência</span>
          </button>
        </div>
      </div>

      {/* Compact Attachment List */}
      {attachments.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Cadeia Sequencial Anexada</span>
            <span className="font-mono tabular-nums">Ordem</span>
          </div>

          <div className="flex flex-col divide-y divide-slate-800/80 border border-slate-800 rounded-md bg-[#0B111E]/60 max-h-44 overflow-y-auto">
            {attachments.map((item) => {
              const isPdf = item.mimeType === 'application/pdf';
              return (
                <div
                  key={item.id}
                  className="p-2.5 flex items-center justify-between gap-2.5 hover:bg-slate-900/60 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="font-mono tabular-nums text-xs font-semibold text-sky-400 shrink-0">
                      #{item.sequenceIndex}
                    </span>

                    {isPdf ? (
                      <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p
                        className="text-xs font-medium text-slate-200 truncate"
                        title={item.name}
                      >
                        {item.name}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                        <span>{formatBytes(item.sizeBytes)}</span>
                        <span aria-hidden="true">·</span>
                        {item.serverUploadStatus === 'uploading' && (
                          <>
                            <span className="text-sky-400">
                              Enviando {item.uploadProgress ?? 0}%
                            </span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        {item.serverUploadStatus === 'synced' && (
                          <>
                            <span className="text-emerald-400">Pronto</span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        {item.serverUploadStatus === 'error' && (
                          <>
                            <span className="text-rose-400">
                              Reenvio pendente
                            </span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        <input
                          type="text"
                          value={item.panelName || ''}
                          onChange={(e) =>
                            onUpdatePanelName(item.id, e.target.value)
                          }
                          placeholder="Painel (ex: PCPG1, QDCC)"
                          aria-label={`Painel do arquivo ${item.name}`}
                          className="bg-transparent border-b border-slate-800 focus:border-sky-500 focus:outline-none text-slate-300 placeholder:text-slate-600 px-1 py-0 text-[11px] w-32"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Category selector + Preview + Remove */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <select
                      aria-label={`Categoria do documento ${item.name}`}
                      value={item.categoryTag}
                      onChange={(e) =>
                        onUpdateCategory(
                          item.id,
                          e.target.value as DiagramCategoryTag
                        )
                      }
                      className="bg-slate-900 border border-slate-700 text-slate-200 text-[11px] font-mono rounded px-1.5 py-1 focus:outline-none focus:border-sky-500 cursor-pointer"
                    >
                      {CATEGORY_OPTIONS.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() => setPreviewAttachment(item)}
                      title="Inspecionar arquivo anexado"
                      className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(item.id)}
                      title="Remover arquivo da sequência"
                      className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400 bg-[#0B111E]/40 border border-slate-800/80 rounded-md p-3 flex items-center justify-between">
          <span>
            Nenhum diagrama anexado. Anexe o caderno PDF (<code>/EL</code>,{' '}
            <code>/RB</code>, <code>/ME</code>, <code>/RM</code>) ou foto do
            painel para iniciar.
          </span>
        </div>
      )}

      {/* Modal for "Adicionar Próximo Desenho na Sequência" */}
      {sequenceModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-slate-700 rounded-lg max-w-lg w-full p-5 flex flex-col gap-4 shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-sky-400 shrink-0" />
                <h3 className="text-sm font-semibold text-slate-100">
                  Adicionar Próximo Desenho na Sequência (#
                  {attachments.length + 1})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSequenceModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Ao selecionar o novo PDF ou foto abaixo, o sistema sincronizará o
              arquivo e <strong>iniciará automaticamente</strong> a próxima
              etapa do diagnóstico mantendo todo o histórico anterior.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-300">
                  Painel / Folha de Destino (Opcional)
                </label>
                <input
                  type="text"
                  value={seqPanelName}
                  onChange={(e) => setSeqPanelName(e.target.value)}
                  placeholder="Ex: PCPG1, Folha 31, QDCC"
                  className="bg-[#0B111E] border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-300">
                  Tipo de Caderno / Folha
                </label>
                <select
                  value={seqCategory}
                  onChange={(e) =>
                    setSeqCategory(e.target.value as DiagramCategoryTag)
                  }
                  className="bg-[#0B111E] border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                >
                  {CATEGORY_OPTIONS.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">
                Foco ou Folha Específica para Rastrear na Sequência (Opcional)
              </label>
              <input
                type="text"
                value={seqNote}
                onChange={(e) => setSeqNote(e.target.value)}
                placeholder="Ex: Analisar Folha 31 (alimentação do Switch) ou Folha 27 (Arquitetura de Rede)"
                className="bg-[#0B111E] border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <input
              ref={sequenceInputRef}
              type="file"
              multiple
              accept=".pdf,application/pdf,image/jpeg,image/png,image/webp"
              onChange={handleSequenceFileChange}
              className="hidden"
            />

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 pt-2 border-t border-slate-800">
              {attachments.length > 0 && onContinueSamePdfInSequence && (
                <button
                  type="button"
                  onClick={handleSamePdfSequenceClick}
                  className="px-3 py-2 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-md transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ArrowRightCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Analisar Próxima Folha no Mesmo PDF</span>
                </button>
              )}

              <div className="flex items-center justify-end gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => setSequenceModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-800 rounded-md transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => sequenceInputRef.current?.click()}
                  className="px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  Selecionar Novo PDF / Foto e Analisar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal for Inspecting Uploaded Diagram/Photo */}
      {previewAttachment && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-slate-700 rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div className="flex items-center gap-2 text-xs text-slate-200 font-mono">
                <span>Sequência #{previewAttachment.sequenceIndex}</span>
                <span>·</span>
                <span>{previewAttachment.categoryTag}</span>
                <span>·</span>
                <span className="font-sans font-semibold">
                  {previewAttachment.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewAttachment(null)}
                className="p-1 text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 bg-[#0B111E] p-4 overflow-auto flex items-center justify-center min-h-[420px]">
              {previewAttachment.mimeType === 'application/pdf' ? (
                <iframe
                  title={previewAttachment.name}
                  src={`data:application/pdf;base64,${previewAttachment.base64Data}`}
                  className="w-full h-[70vh] rounded border border-slate-800"
                />
              ) : (
                <img
                  src={`data:${previewAttachment.mimeType};base64,${previewAttachment.base64Data}`}
                  alt={previewAttachment.name}
                  referrerPolicy="no-referrer"
                  className="max-h-[70vh] max-w-full object-contain rounded border border-slate-800"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
