/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  ShieldCheck,
  History,
  GitCommitHorizontal,
  Trash2,
  FolderOpen,
  CheckSquare,
  Square,
  RotateCcw,
  Search,
  Star,
  GitBranch,
  MessageSquare,
  CheckCircle2,
  Clock,
  Download,
} from 'lucide-react';
import {
  DiagramAttachment,
  DiagramCategoryTag,
  DiagnosticTurn,
  FaultChatMessage,
  InvestigationStatus,
  SafetyChecklistItem,
  SavedInvestigationSummary,
} from './types';
import {
  DiagramUploadPanel,
  formatBytes,
} from './components/DiagramUploadPanel';
import { FaultQueryPanel } from './components/FaultQueryPanel';
import { DiagnosticReportView } from './components/DiagnosticReportView';
import { GitHubDeployPanel } from './components/GitHubDeployModal';
import { prepareClientSmartAttachmentParts } from './utils/pdfClientEngine';

const STORAGE_KEY = 'hydrodiag_saved_investigations_v2';
const BASE64_CHUNK_SIZE = 1500 * 1024;

const INITIAL_SAFETY_CHECKLIST: SafetyChecklistItem[] = [
  {
    id: 'nr10_epi',
    code: 'NR-10.1',
    label: 'EPIs Isolantes e Categoria do Multímetro (CAT III / CAT IV)',
    detail:
      'Conferir luvas isolantes, vestimenta antichama ATPV e pontas de prova íntegras antes de medir barramentos 125 Vcc / 220 Vca.',
    checked: false,
  },
  {
    id: 'kirk_interlock',
    code: 'KIRK-89',
    label:
      'Verificação de Bloqueio Mecânico Kirk (Seccionadoras 89-5 / 89-31 e 52G)',
    detail:
      'Jamais forçar manobra mecânica sem liberação eletromecânica. Respeitar sentido anti-horário (ciclos de 90°) conforme plaqueta do painel.',
    checked: false,
  },
  {
    id: 'loto_cc',
    code: 'LOTO-CC',
    label:
      'Desenergização e Bloqueio LOTO para Substituição de Fusível / Componente',
    detail:
      'Abrir minidisjuntor de comando ou seccionar circuito antes de substituir cartucho fusível tipo HH ou relé auxiliar.',
    checked: false,
  },
  {
    id: 'scada_reset',
    code: 'SCADA-ACK',
    label:
      'Confirmação de Estado nas Entradas Digitais (XED / CLP-SASE / Relé SEL)',
    detail:
      'Após correção física em campo, validar mudança de estado lógico no borne de entrada digital e reconhecer alarme no supervisório.',
    checked: false,
  },
];

function inferCategoryFromFilename(filename: string): DiagramCategoryTag {
  const upper = filename.toUpperCase();
  if (upper.includes('RB') || upper.includes('BORNE')) return '/RB';
  if (upper.includes('ME') || upper.includes('MECANIC')) return '/ME';
  if (
    upper.includes('RM') ||
    upper.includes('MATERIA') ||
    upper.includes('LISTA')
  )
    return '/RM';
  if (
    upper.endsWith('.JPG') ||
    upper.endsWith('.JPEG') ||
    upper.endsWith('.PNG') ||
    upper.endsWith('.WEBP')
  ) {
    return 'FOTO CAMPO';
  }
  return '/EL';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeParseJsonResponse(response: Response): Promise<{
  ok: boolean;
  status: number;
  isHtml: boolean;
  data: Record<string, unknown>;
}> {
  const rawText = await response.text();
  try {
    const parsed = JSON.parse(rawText);
    const isOk = response.ok && parsed?.ok !== false;
    return {
      ok: isOk,
      status: response.status,
      isHtml: false,
      data: parsed,
    };
  } catch {
    const isHtml =
      rawText.trim().toLowerCase().startsWith('<!doctype') ||
      rawText.trim().toLowerCase().startsWith('<html');
    const fallbackError = isHtml
      ? `Sincronizando comunicação com o servidor (HTTP ${response.status})...`
      : `Resposta inesperada do servidor (HTTP ${response.status}): ${rawText.slice(0, 140)}`;
    return {
      ok: false,
      status: response.status,
      isHtml,
      data: { error: fallbackError },
    };
  }
}

export default function App() {
  const [activeNavTab, setActiveNavTab] = useState<
    'bancada' | 'sequencia' | 'seguranca' | 'historico' | 'github'
  >('bancada');

  const reportContainerRef = useRef<HTMLDivElement | null>(null);

  const [sessionId, setSessionId] = useState<string>(() => `inv_${Date.now()}`);
  const [attachments, setAttachments] = useState<DiagramAttachment[]>([]);
  const [turns, setTurns] = useState<DiagnosticTurn[]>([]);
  const [query, setQuery] = useState<string>('');
  const [activeFocusTopic, setActiveFocusTopic] = useState<string>('');

  const [investigationStatus, setInvestigationStatus] =
    useState<InvestigationStatus>('em_investigacao');
  const [fieldResolutionNote, setFieldResolutionNote] = useState<string>('');
  const [isFavorite, setIsFavorite] = useState<boolean>(false);

  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [progressStep, setProgressStep] = useState<string>('');
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const [chatProgressStep, setChatProgressStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [sequenceModalOpen, setSequenceModalOpen] = useState<boolean>(false);

  // History search & filter states
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [historyStatusFilter, setHistoryStatusFilter] =
    useState<string>('todos');
  const [quickBarSearch, setQuickBarSearch] = useState<string>('');

  const [safetyChecklist, setSafetyChecklist] = useState<SafetyChecklistItem[]>(
    INITIAL_SAFETY_CHECKLIST
  );
  const [savedInvestigations, setSavedInvestigations] = useState<
    SavedInvestigationSummary[]
  >([]);

  // Load saved investigations from both Server DB (/api/history) and localStorage on mount
  useEffect(() => {
    const loadHistory = async () => {
      let localItems: SavedInvestigationSummary[] = [];
      try {
        const raw =
          localStorage.getItem(STORAGE_KEY) ||
          localStorage.getItem('hydrodiag_saved_investigations_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            localItems = parsed.map((item) => ({
              status: 'em_investigacao',
              isFavorite: false,
              ...item,
            }));
          }
        }
      } catch {
        // Ignore storage read errors
      }

      try {
        const res = await fetch('/api/history');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.items) && data.items.length > 0) {
            setSavedInvestigations(data.items);
            return;
          }
        }
      } catch {
        // Fallback to localItems
      }

      if (localItems.length > 0) {
        setSavedInvestigations(localItems);
        // Sync local items to server DB
        for (const item of localItems.slice(0, 20)) {
          fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
          }).catch(() => {});
        }
      }
    };
    loadHistory();
  }, []);

  // Automatically persist current session to both LocalStorage and Server DB whenever turns/status/notes change
  useEffect(() => {
    if (turns.length === 0) return;

    const summaryTitle =
      turns[0]?.userQuery || 'Diagnóstico Eletromecânico PCH/UHE';
    const nowIso = new Date().toISOString();
    const updatedEntry: SavedInvestigationSummary = {
      id: sessionId,
      title: summaryTitle,
      status: investigationStatus,
      isFavorite,
      fieldResolutionNote,
      createdAt: turns[0]?.timestamp || nowIso,
      updatedAt: nowIso,
      attachmentMetadata: attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        sequenceIndex: a.sequenceIndex,
        categoryTag: a.categoryTag,
        panelName: a.panelName,
      })),
      turns,
    };

    setSavedInvestigations((prev) => {
      const filtered = prev.filter((item) => item.id !== sessionId);
      const nextList = [updatedEntry, ...filtered].slice(0, 50);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextList));
      } catch {
        // Ignore quota errors
      }
      return nextList;
    });

    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedEntry),
    }).catch(() => {});
  }, [
    turns,
    attachments,
    sessionId,
    investigationStatus,
    fieldResolutionNote,
    isFavorite,
  ]);

  const uploadAttachmentInChunks = async (
    item: DiagramAttachment,
    onChunkProgress?: (pct: number) => void
  ) => {
    const base64 = item.base64Data;
    const totalChunks = Math.max(
      1,
      Math.ceil(base64.length / BASE64_CHUNK_SIZE)
    );

    setAttachments((prev) =>
      prev.map((a) =>
        a.id === item.id
          ? { ...a, serverUploadStatus: 'uploading', uploadProgress: 0 }
          : a
      )
    );

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * BASE64_CHUNK_SIZE;
      const chunkData = base64.slice(start, start + BASE64_CHUNK_SIZE);

      let chunkUploaded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('/api/upload-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attachmentId: item.id,
            name: item.name,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            chunkIndex,
            totalChunks,
            chunkData,
          }),
        });

        const parsed = await safeParseJsonResponse(res);
        if (parsed.ok) {
          chunkUploaded = true;
          break;
        }
        await sleep(1000 * (attempt + 1));
      }

      if (!chunkUploaded) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === item.id ? { ...a, serverUploadStatus: 'error' } : a
          )
        );
        throw new Error(`Falha ao sincronizar o arquivo ${item.name}.`);
      }

      const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
      if (onChunkProgress) {
        onChunkProgress(progress);
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === item.id
            ? {
                ...a,
                serverUploadStatus:
                  chunkIndex + 1 === totalChunks ? 'synced' : 'uploading',
                uploadProgress: progress,
              }
            : a
        )
      );
    }
  };

  const executeDiagnosisCore = async (
    attachmentsToUse: DiagramAttachment[],
    queryToUse: string,
    focusToUse: string
  ) => {
    setIsAnalyzing(true);
    setProgressStep('Iniciando leitura eletromecânica dos diagramas...');
    setError(null);
    setActiveNavTab('bancada');

    setTimeout(() => {
      reportContainerRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 100);

    try {
      const canUseStatelessServerless =
        attachmentsToUse.length === 0 ||
        attachmentsToUse.every((a) => Boolean(a.base64Data));

      if (canUseStatelessServerless) {
        const preparedParts: unknown[] = [];

        for (const att of attachmentsToUse) {
          preparedParts.push({
            text: `[ARQUIVO ANEXADO NA SEQUÊNCIA #${att.sequenceIndex} | Categoria: ${att.categoryTag} | Painel: ${att.panelName || 'Não informado'} | Nome: "${att.name}"]`,
          });
          const { parts } = await prepareClientSmartAttachmentParts(
            att,
            queryToUse,
            focusToUse,
            (msg) => setProgressStep(msg)
          );
          preparedParts.push(...parts);
        }

        setProgressStep(
          'Elaborando diagnóstico detalhado (Guia de Multímetro, Procedimento de Campo, /ME e /RM)...'
        );

        const stepResp = await fetch('/api/serverless-step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'diagnose',
            preparedParts,
            query: queryToUse,
            focusTopic: focusToUse,
            hasAttachments: attachmentsToUse.length > 0,
            history: turns.map((t) => ({
              userQuery: t.userQuery,
              markdownResponse: t.markdownResponse,
            })),
          }),
        });

        const parsedStep = await safeParseJsonResponse(stepResp);
        if (!parsedStep.ok) {
          throw new Error(
            String(
              parsedStep.data.error ||
                'Não foi possível concluir o diagnóstico no servidor.'
            )
          );
        }

        const newTurn: DiagnosticTurn = {
          id: `turn_${Date.now()}`,
          timestamp:
            (parsedStep.data.timestamp as string) || new Date().toISOString(),
          userQuery: queryToUse,
          focusTopic: focusToUse || undefined,
          attachedFileNames: attachmentsToUse.map(
            (a) => `#${a.sequenceIndex} ${a.name} (${a.categoryTag})`
          ),
          sequenceCountAtTurn: attachmentsToUse.length,
          markdownResponse: String(parsedStep.data.markdown || ''),
          requiresNextDrawing: Boolean(parsedStep.data.requiresNextDrawing),
          chatMessages: [],
        };

        setTurns((prev) => [...prev, newTurn]);
        return;
      }

      // Fallback when attachments were restored from history metadata without local base64Data
      for (const att of attachmentsToUse) {
        if (att.serverUploadStatus !== 'synced' && att.base64Data) {
          await uploadAttachmentInChunks(att, (pct) => {
            setProgressStep(
              `Sincronizando desenho #${att.sequenceIndex} (${att.name}): ${pct}%...`
            );
          });
        }
      }

      const startDiagnoseJob = async () => {
        const response = await fetch('/api/diagnose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: queryToUse,
            focusTopic: focusToUse,
            attachments: attachmentsToUse.map((att) => ({
              id: att.id,
              name: att.name,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              sequenceIndex: att.sequenceIndex,
              categoryTag: att.categoryTag,
              panelName: att.panelName,
            })),
            history: turns.map((t) => ({
              userQuery: t.userQuery,
              markdownResponse: t.markdownResponse,
            })),
          }),
        });
        return safeParseJsonResponse(response);
      };

      let startRes = await startDiagnoseJob();

      if (startRes.status === 409 && startRes.data.code === 'NEED_REUPLOAD') {
        setProgressStep('Ressincronizando blocos do PDF no servidor...');
        for (const att of attachmentsToUse) {
          if (att.base64Data) {
            await uploadAttachmentInChunks(att);
          }
        }
        startRes = await startDiagnoseJob();
      }

      if (!startRes.ok || !startRes.data.jobId) {
        throw new Error(
          (startRes.data.error as string) ||
            'Não foi possível iniciar a análise no servidor.'
        );
      }

      const jobId = String(startRes.data.jobId);
      setProgressStep('Varredura iniciada...');

      let finalJobData: Record<string, unknown> | null = null;
      for (let pollCount = 0; pollCount < 180; pollCount++) {
        await sleep(1500);
        const pollResp = await fetch(`/api/diagnose/status/${jobId}`);
        const pollParsed = await safeParseJsonResponse(pollResp);

        if (pollParsed.isHtml) {
          continue;
        }

        if (!pollParsed.ok) {
          throw new Error(
            (pollParsed.data.error as string) ||
              'Erro ao consultar progresso do diagnóstico.'
          );
        }

        if (pollParsed.data.progressStep) {
          setProgressStep(String(pollParsed.data.progressStep));
        }

        if (pollParsed.data.status === 'completed') {
          finalJobData = pollParsed.data;
          break;
        }

        if (pollParsed.data.status === 'error') {
          throw new Error(
            String(
              pollParsed.data.error ||
                'Falha durante o processamento do diagnóstico.'
            )
          );
        }
      }

      if (!finalJobData) {
        throw new Error(
          'Tempo máximo de varredura excedido. Tente novamente — o índice parcial já foi salvo em cache.'
        );
      }

      const newTurn: DiagnosticTurn = {
        id: `turn_${Date.now()}`,
        timestamp:
          (finalJobData.timestamp as string) || new Date().toISOString(),
        userQuery: queryToUse,
        focusTopic: focusToUse || undefined,
        attachedFileNames: attachmentsToUse.map(
          (a) => `#${a.sequenceIndex} ${a.name} (${a.categoryTag})`
        ),
        sequenceCountAtTurn: attachmentsToUse.length,
        markdownResponse: String(finalJobData.markdown || ''),
        requiresNextDrawing: Boolean(finalJobData.requiresNextDrawing),
        chatMessages: [],
      };

      setTurns((prev) => [...prev, newTurn]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erro inesperado ao executar o diagnóstico eletromecânico.'
      );
    } finally {
      setIsAnalyzing(false);
      setProgressStep('');
    }
  };

  // Interactive Chat Handler on Active Fault Turn
  const handleSendChatMessage = async (
    turnId: string,
    messageText: string,
    inlineImage?: { base64: string; mimeType: string; name: string }
  ) => {
    const targetTurn = turns.find((t) => t.id === turnId);
    if (!targetTurn) return;

    const userMsg: FaultChatMessage = {
      id: `cmsg_${Date.now()}_u`,
      role: 'user',
      content: messageText,
      timestamp: new Date().toISOString(),
      attachedImageName: inlineImage?.name,
    };

    const updatedHistory = [...(targetTurn.chatMessages || []), userMsg];

    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId ? { ...t, chatMessages: updatedHistory } : t
      )
    );

    setIsChatSending(true);
    setChatProgressStep(
      'Consultando diagramas e histórico da falha para responder no chat...'
    );
    setError(null);

    try {
      const canUseStatelessServerless =
        attachments.length === 0 ||
        attachments.some((a) => Boolean(a.base64Data));

      if (canUseStatelessServerless) {
        const preparedParts: unknown[] = [];
        const allSelectedPages: number[] = [];

        for (const att of attachments) {
          if (att.base64Data) {
            const { parts, selectedPages } =
              await prepareClientSmartAttachmentParts(
                att,
                `${targetTurn.userQuery || ''} - ${messageText}`,
                targetTurn.markdownResponse
                  ? targetTurn.markdownResponse.slice(0, 600)
                  : '',
                (msg) => setChatProgressStep(msg)
              );
            preparedParts.push(...parts);
            allSelectedPages.push(...selectedPages);
          }
        }

        setChatProgressStep(
          'Analisando circuito e formulando resposta técnica do especialista...'
        );

        const stepResp = await fetch('/api/serverless-step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'chat',
            preparedParts,
            message: messageText,
            alarmTitle: targetTurn.userQuery,
            diagnosticMarkdown: targetTurn.markdownResponse,
            chatHistory: (targetTurn.chatMessages || []).map((m) => ({
              role: m.role,
              content: m.content,
            })),
            inlineImageBase64: inlineImage?.base64,
            inlineImageMimeType: inlineImage?.mimeType,
          }),
        });

        const parsedStep = await safeParseJsonResponse(stepResp);
        if (!parsedStep.ok) {
          throw new Error(
            String(
              parsedStep.data.error ||
                'Não foi possível processar a resposta no chat.'
            )
          );
        }

        const assistantMsg: FaultChatMessage = {
          id: `cmsg_${Date.now()}_a`,
          role: 'assistant',
          content: String(parsedStep.data.markdown || ''),
          timestamp:
            (parsedStep.data.timestamp as string) || new Date().toISOString(),
          inspectedPages:
            allSelectedPages.length > 0 ? allSelectedPages : undefined,
        };

        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId
              ? {
                  ...t,
                  chatMessages: [...(t.chatMessages || []), assistantMsg],
                }
              : t
          )
        );
        return;
      }

      // Fallback when session was reopened from history without local base64Data
      const startResp = await fetch('/api/chat-fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: messageText,
          alarmTitle: targetTurn.userQuery,
          diagnosticMarkdown: targetTurn.markdownResponse,
          chatHistory: (targetTurn.chatMessages || []).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          attachments: attachments.map((att) => ({
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            sizeBytes: att.sizeBytes,
          })),
          inlineImageBase64: inlineImage?.base64,
          inlineImageMimeType: inlineImage?.mimeType,
        }),
      });

      const startParsed = await safeParseJsonResponse(startResp);
      if (!startParsed.ok || !startParsed.data.jobId) {
        throw new Error(
          (startParsed.data.error as string) ||
            'Não foi possível iniciar resposta no chat.'
        );
      }

      const jobId = String(startParsed.data.jobId);
      let finalData: Record<string, unknown> | null = null;

      for (let i = 0; i < 120; i++) {
        await sleep(1400);
        const pollResp = await fetch(`/api/diagnose/status/${jobId}`);
        const pollParsed = await safeParseJsonResponse(pollResp);
        if (pollParsed.isHtml) continue;

        if (pollParsed.data.progressStep) {
          setChatProgressStep(String(pollParsed.data.progressStep));
        }

        if (pollParsed.data.status === 'completed') {
          finalData = pollParsed.data;
          break;
        }
        if (pollParsed.data.status === 'error') {
          throw new Error(
            String(pollParsed.data.error || 'Erro ao responder no chat.')
          );
        }
      }

      if (finalData) {
        const assistantMsg: FaultChatMessage = {
          id: `cmsg_${Date.now()}_a`,
          role: 'assistant',
          content: String(finalData.markdown || ''),
          timestamp:
            (finalData.timestamp as string) || new Date().toISOString(),
          inspectedPages: Array.isArray(finalData.inspectedPages)
            ? (finalData.inspectedPages as number[])
            : undefined,
        };

        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId
              ? {
                  ...t,
                  chatMessages: [...(t.chatMessages || []), assistantMsg],
                }
              : t
          )
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erro ao processar mensagem no chat com o especialista.'
      );
    } finally {
      setIsChatSending(false);
      setChatProgressStep('');
    }
  };

  const handleAddAttachments = async (
    fileList: FileList,
    isSequentialNext: boolean,
    defaultCategory?: DiagramCategoryTag,
    panelHint?: string,
    customSequenceNote?: string
  ) => {
    setIsUploading(true);
    setError(null);

    if (isSequentialNext) {
      setIsAnalyzing(true);
      setProgressStep(
        'Lendo próximo desenho anexado na sequência e preparando sincronização...'
      );
      setActiveNavTab('bancada');
      setTimeout(() => {
        reportContainerRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 80);
    }

    try {
      const filesArray = Array.from(fileList);
      const newItems: DiagramAttachment[] = [];

      let nextSeqIndex = attachments.length + 1;
      for (const file of filesArray) {
        const base64Data = await fileToBase64(file);
        const categoryTag =
          defaultCategory || inferCategoryFromFilename(file.name);

        newItems.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          mimeType:
            file.type ||
            (file.name.toLowerCase().endsWith('.pdf')
              ? 'application/pdf'
              : 'image/jpeg'),
          sizeBytes: file.size,
          base64Data,
          sequenceIndex: nextSeqIndex++,
          categoryTag,
          panelName: panelHint,
          addedAtTimestamp: new Date().toISOString(),
          serverUploadStatus: 'synced',
          uploadProgress: 100,
        });
      }

      const combinedAttachments = [...attachments, ...newItems];
      setAttachments(combinedAttachments);

      // Background sync to local/server disk cache if available (non-blocking for Vercel Serverless)
      for (const item of newItems) {
        uploadAttachmentInChunks(item).catch(() => {});
      }

      const syncedCombined = combinedAttachments;

      if (isSequentialNext && newItems.length > 0) {
        const namesJoined = newItems.map((n) => n.name).join(', ');
        const panelDesc = panelHint ? ` (Painel/Destino: ${panelHint})` : '';
        const prevAlarmContext =
          turns.length > 0
            ? turns[0].userQuery
            : query.trim() || 'Falha em investigação';

        const autoSeqQuery = customSequenceNote
          ? `Continuidade na Sequência (#${newItems[0].sequenceIndex} - ${namesJoined}${panelDesc}): ${customSequenceNote} (Alarme original: ${prevAlarmContext})`
          : `Anexei o próximo desenho na sequência (#${newItems[0].sequenceIndex}: ${namesJoined}${panelDesc}) dando continuidade ao diagnóstico de "${prevAlarmContext}". Analise a chegada/continuidade do sinal elétrico neste documento (e as folhas sugeridas na etapa anterior), indique os bornes de medição com multímetro, localização física (/ME), código da peça (/RM) e procedimento de correção.`;

        setQuery(autoSeqQuery);
        await executeDiagnosisCore(
          syncedCombined,
          autoSeqQuery,
          activeFocusTopic
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível ler ou sincronizar um dos arquivos selecionados.'
      );
      setIsAnalyzing(false);
      setProgressStep('');
    } finally {
      setIsUploading(false);
    }
  };

  const handleContinueSamePdfInSequence = async (customNote: string) => {
    setQuery(customNote);
    await executeDiagnosisCore(attachments, customNote, activeFocusTopic);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => {
      const filtered = prev.filter((item) => item.id !== id);
      return filtered.map((item, idx) => ({
        ...item,
        sequenceIndex: idx + 1,
      }));
    });
  };

  const handleUpdateCategory = (id: string, category: DiagramCategoryTag) => {
    setAttachments((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, categoryTag: category } : item
      )
    );
  };

  const handleUpdatePanelName = (id: string, panelName: string) => {
    setAttachments((prev) =>
      prev.map((item) => (item.id === id ? { ...item, panelName } : item))
    );
  };

  const handleRunDiagnosis = async (overrideFocusTopic?: string) => {
    const focusToUse =
      overrideFocusTopic !== undefined ? overrideFocusTopic : activeFocusTopic;
    const effectiveQuery =
      query.trim() ||
      (turns.length > 0
        ? turns[turns.length - 1].userQuery
        : 'Análise técnica de falha nos diagramas anexados');

    const displayQuery =
      overrideFocusTopic && !query.trim()
        ? `${effectiveQuery} (${overrideFocusTopic.split(':')[0]})`
        : effectiveQuery;

    await executeDiagnosisCore(attachments, displayQuery, focusToUse);
  };

  const handleNewInvestigation = () => {
    setSessionId(`inv_${Date.now()}`);
    setAttachments([]);
    setTurns([]);
    setQuery('');
    setActiveFocusTopic('');
    setInvestigationStatus('em_investigacao');
    setFieldResolutionNote('');
    setIsFavorite(false);
    setError(null);
    setSafetyChecklist(
      INITIAL_SAFETY_CHECKLIST.map((item) => ({ ...item, checked: false }))
    );
    setActiveNavTab('bancada');
  };

  const handleLoadInvestigation = (saved: SavedInvestigationSummary) => {
    setSessionId(saved.id);
    setTurns(saved.turns);
    setInvestigationStatus(saved.status || 'em_investigacao');
    setFieldResolutionNote(saved.fieldResolutionNote || '');
    setIsFavorite(Boolean(saved.isFavorite));
    // Restore attachment metadata so server can match cached PDFs in /tmp/hydrodiag_uploads by size/name!
    setAttachments(
      (saved.attachmentMetadata || []).map((meta) => ({
        ...meta,
        base64Data: '',
        addedAtTimestamp: saved.createdAt,
        serverUploadStatus: 'synced',
        uploadProgress: 100,
      }))
    );
    setQuery(saved.turns[saved.turns.length - 1]?.userQuery || '');
    setError(null);
    setActiveNavTab('bancada');
  };

  const handleToggleFavorite = (id: string) => {
    setSavedInvestigations((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, isFavorite: !item.isFavorite } : item
      );
      const target = next.find((i) => i.id === id);
      if (target) {
        fetch(`/api/history/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isFavorite: target.isFavorite }),
        }).catch(() => {});
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore
      }
      return next;
    });
  };

  const handleDeleteSavedInvestigation = (id: string) => {
    setSavedInvestigations((prev) => {
      const next = prev.filter((item) => item.id !== id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage error
      }
      return next;
    });
    fetch(`/api/history/${id}`, { method: 'DELETE' }).catch(() => {});
  };

  const handleExportHistoryJson = () => {
    const blob = new Blob([JSON.stringify(savedInvestigations, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hydrodiag_historico_falhas_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleChecklistItem = (id: string) => {
    setSafetyChecklist((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, checked: !item.checked } : item
      )
    );
  };

  // Filtered list for History Tab
  const filteredSavedInvestigations = savedInvestigations.filter((item) => {
    if (historyStatusFilter !== 'todos') {
      if (historyStatusFilter === 'favoritos' && !item.isFavorite) return false;
      if (
        historyStatusFilter !== 'favoritos' &&
        (item.status || 'em_investigacao') !== historyStatusFilter
      ) {
        return false;
      }
    }
    if (!historySearchQuery.trim()) return true;
    const q = historySearchQuery.toLowerCase();
    const inTitle = item.title.toLowerCase().includes(q);
    const inNote = (item.fieldResolutionNote || '').toLowerCase().includes(q);
    const inFiles = item.attachmentMetadata.some((a) =>
      a.name.toLowerCase().includes(q)
    );
    const inTurns = item.turns.some(
      (t) =>
        t.userQuery.toLowerCase().includes(q) ||
        t.markdownResponse.toLowerCase().includes(q) ||
        (t.chatMessages || []).some((cm) =>
          cm.content.toLowerCase().includes(q)
        )
    );
    return inTitle || inNote || inFiles || inTurns;
  });

  // Filtered list for Workbench Quick History Bar
  const quickFilteredHistory = savedInvestigations
    .filter((item) => {
      if (!quickBarSearch.trim()) return true;
      const q = quickBarSearch.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        (item.fieldResolutionNote || '').toLowerCase().includes(q) ||
        item.turns.some((t) => t.markdownResponse.toLowerCase().includes(q))
      );
    })
    .slice(0, 6);

  return (
    <div className="min-h-screen bg-[#0B111E] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800 bg-[#0B111E] no-print">
        <a
          href="#bancada"
          onClick={(e) => {
            e.preventDefault();
            setActiveNavTab('bancada');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 font-display"
        >
          HydroDiag AI
        </a>

        <nav
          aria-label="Navegação Principal"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400"
        >
          <a
            href="#bancada"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('bancada');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeNavTab === 'bancada'
                ? 'text-sky-400 underline underline-offset-8 decoration-2 decoration-sky-400'
                : ''
            }`}
          >
            Bancada de Diagnóstico
          </a>
          <a
            href="#historico"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('historico');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeNavTab === 'historico'
                ? 'text-sky-400 underline underline-offset-8 decoration-2 decoration-sky-400'
                : ''
            }`}
          >
            Histórico de Falhas ({savedInvestigations.length})
          </a>
          <a
            href="#sequencia"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('sequencia');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeNavTab === 'sequencia'
                ? 'text-sky-400 underline underline-offset-8 decoration-2 decoration-sky-400'
                : ''
            }`}
          >
            Sequência de Desenhos
          </a>
          <a
            href="#seguranca"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('seguranca');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeNavTab === 'seguranca'
                ? 'text-sky-400 underline underline-offset-8 decoration-2 decoration-sky-400'
                : ''
            }`}
          >
            Segurança NR-10
          </a>
          <a
            href="#github"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('github');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeNavTab === 'github'
                ? 'text-sky-400 underline underline-offset-8 decoration-2 decoration-sky-400'
                : ''
            }`}
          >
            Vercel & GitHub
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleNewInvestigation}
            className="px-4 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nova Investigação</span>
          </button>
        </div>
      </header>

      {/* Mobile Tab Bar */}
      <div className="flex md:hidden items-center gap-2 px-4 py-2 border-b border-slate-800 bg-[#111827] overflow-x-auto no-print">
        <button
          type="button"
          onClick={() => setActiveNavTab('bancada')}
          className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
            activeNavTab === 'bancada'
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-slate-400'
          }`}
        >
          Bancada
        </button>
        <button
          type="button"
          onClick={() => setActiveNavTab('historico')}
          className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
            activeNavTab === 'historico'
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-slate-400'
          }`}
        >
          Histórico ({savedInvestigations.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveNavTab('sequencia')}
          className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
            activeNavTab === 'sequencia'
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-slate-400'
          }`}
        >
          Sequência ({attachments.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveNavTab('seguranca')}
          className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
            activeNavTab === 'seguranca'
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-slate-400'
          }`}
        >
          NR-10
        </button>
        <button
          type="button"
          onClick={() => setActiveNavTab('github')}
          className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
            activeNavTab === 'github'
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-slate-400'
          }`}
        >
          Vercel & GitHub
        </button>
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-4 no-print">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-100 tracking-tight">
              Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de
              Falhas (PCH / UHE)
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Análise especialista de diagramas unifilares e multifilares{' '}
              <code className="text-sky-300">/EL</code> · Réguas de bornes{' '}
              <code className="text-sky-300">/RB</code> · Layout mecânico{' '}
              <code className="text-sky-300">/ME</code> · Relação de materiais{' '}
              <code className="text-sky-300">/RM</code>
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400 font-mono tabular-nums shrink-0">
            <span>Barramentos 125 Vcc / 220 Vca</span>
            <span aria-hidden="true">·</span>
            <span>Normas WEG / IEC / ANSI</span>
          </div>
        </div>

        {/* TAB 1: BANCADA DE DIAGNÓSTICO */}
        {activeNavTab === 'bancada' && (
          <div className="flex flex-col gap-5">
            {/* Quick Recent Faults Search & Recall Bar */}
            {savedInvestigations.length > 0 && (
              <div className="bg-[#111827] border border-slate-800 rounded-lg px-4 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3 no-print">
                <div className="flex items-center gap-2 shrink-0">
                  <History className="w-4 h-4 text-sky-400" />
                  <span className="text-xs font-semibold text-slate-200">
                    Últimos Históricos de Falhas Salvos:
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                  {quickFilteredHistory.map((item) => {
                    const isActive = item.id === sessionId && turns.length > 0;
                    const chatCount = item.turns.reduce(
                      (acc, t) => acc + (t.chatMessages?.length || 0),
                      0
                    );
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleLoadInvestigation(item)}
                        className={`px-2.5 py-1 rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer max-w-[260px] truncate border ${
                          isActive
                            ? 'bg-sky-500/20 border-sky-500/50 text-sky-200 font-medium'
                            : 'bg-[#0B111E] border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white'
                        }`}
                        title={`Reabrir diagnóstico: ${item.title}`}
                      >
                        {item.status === 'resolvida' && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        )}
                        <span className="truncate">{item.title}</span>
                        {chatCount > 0 && (
                          <span className="font-mono text-[10px] text-sky-400 shrink-0">
                            ({chatCount} msg)
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={quickBarSearch}
                      onChange={(e) => setQuickBarSearch(e.target.value)}
                      placeholder="Filtrar histórico rápido..."
                      className="bg-[#0B111E] border border-slate-800 focus:border-sky-500 rounded-md pl-8 pr-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none w-44"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveNavTab('historico')}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium whitespace-nowrap cursor-pointer"
                  >
                    Ver Todos ({savedInvestigations.length})
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-5 flex flex-col gap-5 no-print">
                <DiagramUploadPanel
                  attachments={attachments}
                  onAddAttachments={handleAddAttachments}
                  onContinueSamePdfInSequence={handleContinueSamePdfInSequence}
                  onRemoveAttachment={handleRemoveAttachment}
                  onUpdateCategory={handleUpdateCategory}
                  onUpdatePanelName={handleUpdatePanelName}
                  isUploading={isUploading}
                  sequenceModalOpen={sequenceModalOpen}
                  setSequenceModalOpen={setSequenceModalOpen}
                />

                <FaultQueryPanel
                  query={query}
                  setQuery={setQuery}
                  activeFocusTopic={activeFocusTopic}
                  setActiveFocusTopic={setActiveFocusTopic}
                  onRunDiagnosis={handleRunDiagnosis}
                  isAnalyzing={isAnalyzing}
                  hasPreviousTurns={turns.length > 0}
                />
              </div>

              <div ref={reportContainerRef} className="lg:col-span-7">
                <DiagnosticReportView
                  turns={turns}
                  attachments={attachments}
                  isAnalyzing={isAnalyzing}
                  progressStep={progressStep}
                  error={error}
                  onOpenSequenceUpload={() => setSequenceModalOpen(true)}
                  onQuickFollowUp={async (followUpPrompt) => {
                    setQuery(followUpPrompt);
                    await executeDiagnosisCore(
                      attachments,
                      followUpPrompt,
                      activeFocusTopic
                    );
                  }}
                  onSendChatMessage={handleSendChatMessage}
                  isChatSending={isChatSending}
                  chatProgressStep={chatProgressStep}
                  investigationStatus={investigationStatus}
                  onUpdateStatus={setInvestigationStatus}
                  fieldResolutionNote={fieldResolutionNote}
                  onUpdateResolutionNote={setFieldResolutionNote}
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: CENTRAL DE HISTÓRICO & BUSCA DE FALHAS */}
        {activeNavTab === 'historico' && (
          <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <History className="w-4 h-4 text-sky-400" />
                  <span>
                    Base de Conhecimento & Histórico de Falhas da Usina
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Pesquise por alarme, borne (ex: <code>XED:217</code>), folha (
                  <code>Folha 49</code>), equipamento ou solução aplicada em
                  campo
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportHistoryJson}
                  disabled={savedInvestigations.length === 0}
                  className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 rounded-md flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-sky-400" />
                  <span>Exportar Base JSON</span>
                </button>
              </div>
            </div>

            {/* Search Input + Status Filter Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={historySearchQuery}
                  onChange={(e) => setHistorySearchQuery(e.target.value)}
                  placeholder="Buscar nos laudos, conversas do chat, bornes, códigos /RM ou notas de resolução..."
                  className="w-full bg-[#0B111E] border border-slate-700 focus:border-sky-500 rounded-md pl-10 pr-4 py-2 text-xs sm:text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-[#0B111E] border border-slate-800 rounded-md overflow-x-auto">
                {[
                  { id: 'todos', label: 'Todos' },
                  { id: 'em_investigacao', label: 'Em Investigação' },
                  { id: 'resolvida', label: 'Resolvidas' },
                  { id: 'aguardando_peca', label: 'Aguardando Peça' },
                  { id: 'favoritos', label: 'Favoritos' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setHistoryStatusFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      historyStatusFilter === tab.id
                        ? 'bg-sky-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {filteredSavedInvestigations.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 bg-[#0B111E]/60 border border-slate-800 rounded-md">
                Nenhum registro encontrado para o filtro ou termo pesquisado.
              </div>
            ) : (
              <div className="divide-y divide-slate-800 border border-slate-800 rounded-md bg-[#0B111E]/60">
                {filteredSavedInvestigations.map((item) => {
                  const totalChatMsgs = item.turns.reduce(
                    (acc, t) => acc + (t.chatMessages?.length || 0),
                    0
                  );
                  return (
                    <div
                      key={item.id}
                      className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-900/60 transition-colors"
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleFavorite(item.id)}
                            className="text-slate-500 hover:text-amber-400 cursor-pointer shrink-0"
                            title="Marcar como favorito"
                          >
                            <Star
                              className={`w-4 h-4 ${
                                item.isFavorite
                                  ? 'fill-amber-400 text-amber-400'
                                  : ''
                              }`}
                            />
                          </button>
                          <p className="text-sm font-semibold text-slate-100 truncate">
                            {item.title}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-sky-400" />
                            {new Date(item.updatedAt).toLocaleString('pt-BR')}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {item.status === 'resolvida'
                              ? 'Resolvida em Campo'
                              : item.status === 'aguardando_peca'
                              ? 'Aguardando Peça'
                              : 'Em Investigação'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{item.turns.length} etapa(s)</span>
                          <span aria-hidden="true">·</span>
                          <span className="flex items-center gap-1 text-sky-300">
                            <MessageSquare className="w-3 h-3" />
                            {totalChatMsgs} msg no chat
                          </span>
                        </div>

                        {item.fieldResolutionNote && (
                          <p className="text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-800/50 rounded px-2.5 py-1 inline-block">
                            <strong>Solução Registrada:</strong>{' '}
                            {item.fieldResolutionNote}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleLoadInvestigation(item)}
                          className="px-3.5 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>Reabrir Laudo e Chat</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSavedInvestigation(item.id)}
                          className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors cursor-pointer"
                          title="Excluir do histórico"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: SEQUÊNCIA DE DESENHOS */}
        {activeNavTab === 'sequencia' && (
          <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <GitCommitHorizontal className="w-4 h-4 text-sky-400" />
                  <span>
                    Rastreamento Sequencial de Desenhos entre Painéis da Usina
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Visualize a cadeia de cadernos PDF e fotos anexadas quando o
                  sinal elétrico sai de um painel para outro (ex: PCPG1 →
                  PSE+CLP-SASE → QDCC)
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setActiveNavTab('bancada');
                  setSequenceModalOpen(true);
                }}
                className="px-3.5 py-2 text-xs font-medium text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                Adicionar Próximo Desenho na Sequência
              </button>
            </div>

            {attachments.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400 bg-[#0B111E]/60 border border-slate-800 rounded-md">
                Nenhum desenho anexado na sequência atual. Volte à Bancada de
                Diagnóstico para anexar o primeiro PDF ou foto de campo.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-800 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="bg-[#0B111E] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Ordem</th>
                      <th className="py-2.5 px-4 font-medium">Tipo de Folha</th>
                      <th className="py-2.5 px-4 font-medium">
                        Arquivo Anexado
                      </th>
                      <th className="py-2.5 px-4 font-medium">
                        Painel / Destino
                      </th>
                      <th className="py-2.5 px-4 font-medium text-right">
                        Tamanho
                      </th>
                      <th className="py-2.5 px-4 font-medium text-right">
                        Horário de Inclusão
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {attachments.map((att) => (
                      <tr
                        key={att.id}
                        className="hover:bg-slate-900/50 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono tabular-nums font-semibold text-sky-400">
                          Sequência #{att.sequenceIndex}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-200">
                          {att.categoryTag}
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-100">
                          {att.name}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-300">
                          {att.panelName || 'Não especificado'}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-400 text-right">
                          {formatBytes(att.sizeBytes)}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-400 text-right">
                          {new Date(att.addedAtTimestamp).toLocaleTimeString(
                            'pt-BR'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* TAB 4: CHECKLIST NR-10 */}
        {activeNavTab === 'seguranca' && (
          <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>
                    Checklist Operacional de Segurança NR-10, Bloqueio LOTO e
                    Intertravamento Kirk
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Conferência obrigatória antes de testes com ponta de prova
                  (125 Vcc / 220 Vca) e manobras em chaves seccionadoras 89-5 /
                  89-31 e disjuntores 52G1 / 52G2
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSafetyChecklist((prev) =>
                    prev.map((i) => ({ ...i, checked: false }))
                  )
                }
                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-800 rounded-md flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reiniciar Checklist</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {safetyChecklist.map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleChecklistItem(item.id)}
                  className={`p-4 rounded-lg border transition-colors cursor-pointer flex items-start gap-3.5 ${
                    item.checked
                      ? 'bg-emerald-950/20 border-emerald-700/50'
                      : 'bg-[#0B111E] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <button
                    type="button"
                    aria-label={item.label}
                    className="mt-0.5 text-sky-400 shrink-0"
                  >
                    {item.checked ? (
                      <CheckSquare className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-500" />
                    )}
                  </button>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-semibold text-sky-400">
                        {item.code}
                      </span>
                      <span className="text-xs font-semibold text-slate-100">
                        {item.label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {item.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* TAB 5: PUBLICAR NO GITHUB (@marcondi) */}
        {activeNavTab === 'github' && <GitHubDeployPanel />}
      </main>

      <footer className="mt-auto border-t border-slate-800/80 px-6 py-4 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4 no-print">
        <span>
          HydroDiag AI — Sistema Especialista de Diagnóstico Eletromecânico para
          PCH / UHE
        </span>
        <div className="flex items-center gap-4 font-mono tabular-nums">
          <span>Diagramas /EL · /RB · /ME · /RM</span>
          <a
            href="#github"
            onClick={(e) => {
              e.preventDefault();
              setActiveNavTab('github');
            }}
            className="text-sky-400 hover:underline flex items-center gap-1"
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>github.com/marcondi</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
