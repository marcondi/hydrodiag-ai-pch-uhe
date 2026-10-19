import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const UPLOAD_DIR = path.join(os.tmpdir(), 'hydrodiag_uploads');
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch {
  // Ignore on restricted environments
}

const HISTORY_DB_PATH = path.join(UPLOAD_DIR, 'fault_history_db.json');

interface StoredAttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  totalChunks: number;
  receivedChunks: Map<number, string>;
  completeBase64?: string;
  filePath?: string;
  updatedAt: number;
}

interface PageBatchIndex {
  startPage: number;
  endPage: number;
  summary: string;
}

interface DiagnosticJob {
  id: string;
  type: 'diagnose' | 'chat';
  status: 'running' | 'completed' | 'error';
  progressStep: string;
  payload: Record<string, unknown>;
  nextBatchStartPageIndex: number;
  isProcessingStep: boolean;
  markdown?: string;
  requiresNextDrawing?: boolean;
  inspectedPages?: number[];
  modelUsed?: string;
  timestamp?: string;
  error?: string;
  createdAt: number;
}

const attachmentStore = new Map<string, StoredAttachmentRecord>();
const diagnosticJobs = new Map<string, DiagnosticJob>();

const SYSTEM_INSTRUCTION = `Você é um Sistema Especialista Híbrido composto por um Engenheiro Eletricista Sênior de Manutenção/Proteção de Usinas Hidrelétricas (PCH/UHE) e um Engenheiro de Automação.
Sua missão é analisar cadernos de projetos elétricos industriais (padrão WEG/IEC/ANSI, contendo diagramas unifilares, funcionais \`/EL\`, mecânicos \`/ME\`, materiais \`/RM\` e réguas de bornes \`/RB\`) enviados em PDF ou imagem para localizar falhas sinalizadas no supervisório e ensinar como corrigi-las passo a passo.

DIRETRIZES DE ANÁLISE TÉCNICA E RESOLUÇÃO:
1. VARREDURA E LOCALIZAÇÃO:
   - Localize a Folha exata (\`/EL\`, \`/RB\`, \`/ME\`, \`/RM\`), o número da página do PDF e a coordenada (Linha A-F, Coluna 1-8) que envia a informação da falha para o supervisório/CLP (ex: entradas digitais \`XED\`, cartões de CLP, relés SEL).
   - Se o alarme consultado (ex: "Baixa pressão de óleo na UHLM") NÃO pertencer ao PDF anexado atualmente, avise claramente o que consta no PDF atual e peça para o usuário subir o caderno elétrico correspondente (ex: Painel da Unidade Geradora \`PCPG\`, \`CLP-SASE\` ou \`QDCC\`).

2. RASTREAMENTO E REFERÊNCIAS CRUZADAS:
   - Siga os barramentos de comando (ex: \`125 Vcc\`, \`220 Vca\`) e leia as referências cruzadas (\`Folha/LinhaColuna\`, ex: \`3/E4\`) para identificar bobinas (\`A1-A2\`), contatos auxiliares e intertravamentos.

3. GUIA PRÁTICO DE MULTÍMETRO (PONTA DE PROVA):
   - Indique exatamente em qual Régua de Bornes (ex: \`1X2\`, \`2X2\`, \`3X2\`, \`4X2\`, \`3XD\`) e em qual número de borne colocar a ponta de prova vermelha (+) e a preta (-) do multímetro para medir os \`125 Vcc\` (ou continuidade).
   - Especifique qual contato \`NA\` (Normalmente Aberto) ou \`NF\` (Normalmente Fechado) testar (indicando a numeração dos terminais, ex: \`13-14\`, \`21-22\`, \`31-32\`, \`43-44\` ou pinos da tomada \`XB1\`), explicando o valor esperado em condição normal e em condição de falha.

4. PROCEDIMENTO DE RESOLUÇÃO E CORREÇÃO DA FALHA:
   - Forneça um guia de ação corretiva claro e seguro para o operador/eletricista resolver o problema com base no diagrama elétrico.
   - Especifique a manobra física necessária (ex: substituição de cartucho de fusível tipo HH, rearme de minidisjuntor termomagnético, correção de sinalização no supervisório).
   - Se envolver chaves seccionadoras (\`89-5\`, \`89-31\`) ou disjuntores a vácuo (\`52G1\`/\`52G2\`), alerte sobre intertravamentos mecânicos, bloqueios Kirk e o sentido correto de acionamento (ex: ciclos de 90° no sentido anti-horário conforme as plaquetas de advertência do projeto).

5. LOCALIZAÇÃO FÍSICA E REPOSIÇÃO DE PEÇA:
   - Consulte os Desenhos Mecânicos (\`/ME\`) e descreva a posição física exata do componente no painel (Coluna, compartimento de baixa/média tensão).
   - Consulte a Relação de Materiais (\`/RM\`) e informe TAG, Fabricante, Modelo e Código do material para substituição.

6. NAVEGAÇÃO SEQUENCIAL ENTRE DESENHOS:
   - Quando o sinal sair para outro documento externo (indicado por linhas tracejadas na régua de bornes ou funcional), informe o Número do Documento externo (ex: \`10001879846-PRJ\`), o nome do painel (\`PCPG1\`, \`PCPG2\`, \`PSE+CLP-SASE\`), a Folha de destino (\`EL.xx\`) e os bornes de chegada, solicitando o upload desse desenho na sequência caso necessário.

FORMATO OBRIGATÓRIO DE RESPOSTA:
### 🚨 1. Diagnóstico e Localização no Desenho
### 📟 2. Guia de Teste com Multímetro (Passo a Passo)
### 🛠️ 3. Como Resolver e Corrigir a Falha (Procedimento de Campo)
### 🗄️ 4. Localização Física no Painel (/ME) e Dados da Peça (/RM)
### 🔄 5. Próximo Desenho na Sequência (Se aplicável)
Caso haja novas dúvidas ou falhas, forneça o próximo diagrama detalhado.`;

const CHAT_SYSTEM_INSTRUCTION = `Você é o Copiloto Especialista em Manutenção Eletromecânica e Automação de Usinas Hidrelétricas (PCH/UHE), conversando em tempo real com o operador/eletricista sobre uma falha em investigação.
Você tem acesso ao índice completo do caderno elétrico em PDF anexado, às páginas recortadas em alta resolução do diagrama (/EL, /RB, /ME, /RM) e ao histórico do diagnóstico.
DIRETRIZES DO CHAT INTERATIVO:
- Responda de forma direta, técnica, prática e altamente precisa (citando Folha, Página do PDF, Coordenada Linha/Coluna, Régua de Bornes, terminais NA/NF, tensões 125Vcc/24Vcc/220Vca e códigos da lista de materiais /RM).
- Se o operador pedir para analisar outra Folha específica do mesmo PDF (ex: "Analise a Folha 27", "Veja a Folha 31"), examine minuciosamente as páginas recortadas fornecidas neste turno e entregue todos os detalhes de circuito, bornes e componentes.
- Se o operador relatar o resultado de uma medição em campo (ex: "Medi 0Vcc no borne XED:217" ou "O disjuntor está armado mas o LED apagado"), raciocine sobre o circuito elétrico passo a passo e indique o próximo ponto exato de teste com as pontas de prova (+) e (-).`;

function getGeminiClient() {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Chave GEMINI_API_KEY não configurada na Vercel! Vá em Settings > Environment Variables na Vercel e adicione GEMINI_API_KEY.'
    );
  }
  return new GoogleGenAI({ apiKey });
}

function readHistoryDb(): unknown[] {
  try {
    if (fs.existsSync(HISTORY_DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_DB_PATH, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore
  }
  return [];
}

function writeHistoryDb(items: unknown[]) {
  try {
    fs.writeFileSync(HISTORY_DB_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch {
    // Ignore
  }
}

function findStoredAttachment(fileMeta: {
  id?: string;
  name?: string;
  sizeBytes?: number;
}): StoredAttachmentRecord | undefined {
  if (fileMeta.id) {
    const direct = attachmentStore.get(fileMeta.id);
    if (direct && (direct.filePath || direct.completeBase64)) return direct;
  }
  for (const rec of attachmentStore.values()) {
    if (
      rec.filePath &&
      fs.existsSync(rec.filePath) &&
      ((fileMeta.sizeBytes && rec.sizeBytes === fileMeta.sizeBytes) ||
        (fileMeta.name &&
          rec.filePath.includes(
            fileMeta.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 20)
          )))
    ) {
      return rec;
    }
  }
  if (attachmentStore.size > 0) {
    return Array.from(attachmentStore.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    )[0];
  }
  return undefined;
}

async function callGeminiFast(
  ai: GoogleGenAI,
  parts: unknown[],
  systemPrompt: string | null,
  thinkingLevel: ThinkingLevel = ThinkingLevel.LOW
): Promise<{ text: string; modelUsed: string }> {
  const candidateModels = [
    { name: 'gemini-2.5-flash', thinking: undefined },
    { name: 'gemini-3-flash-preview', thinking: thinkingLevel },
    { name: 'gemini-flash-latest', thinking: undefined },
    { name: 'gemini-2.0-flash', thinking: undefined },
  ];

  let lastError: unknown = null;
  for (const candidate of candidateModels) {
    try {
      const config: Record<string, unknown> = { temperature: 0.2 };
      if (systemPrompt) config.systemInstruction = systemPrompt;
      if (candidate.thinking) {
        config.thinkingConfig = { thinkingLevel: candidate.thinking };
      }
      const response = await ai.models.generateContent({
        model: candidate.name,
        contents: { parts: parts as never[] },
        config,
      });
      if (response && response.text) {
        return { text: response.text, modelUsed: candidate.name };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Serviço Gemini temporariamente indisponível.');
}

function getIndexCachePath(sizeBytes: number): string {
  return path.join(UPLOAD_DIR, `idx_${sizeBytes}.json`);
}

function readCachedIndex(sizeBytes: number): PageBatchIndex[] {
  const p = getIndexCachePath(sizeBytes);
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore
  }
  return [];
}

function saveCachedIndex(sizeBytes: number, batches: PageBatchIndex[]) {
  try {
    fs.writeFileSync(
      getIndexCachePath(sizeBytes),
      JSON.stringify(batches, null, 2)
    );
  } catch {
    // Ignore
  }
}

/**
 * Advances a job by 1 incremental step per poll so each HTTP request finishes
 * in ~3-6 seconds (never hitting Vercel Serverless timeout or background freeze).
 */
async function advanceJobOneStep(job: DiagnosticJob) {
  if (job.status !== 'running' || job.isProcessingStep) return;
  job.isProcessingStep = true;

  try {
    const ai = getGeminiClient();
    const attachments = (job.payload.attachments as Array<{
      id: string;
      name: string;
      mimeType: string;
      sizeBytes?: number;
      sequenceIndex?: number;
      categoryTag?: string;
      panelName?: string;
    }>) || [];

    // 1. Check if any large PDF attachment still needs incremental batch indexing
    for (const attMeta of attachments) {
      const stored = findStoredAttachment(attMeta);
      if (
        stored &&
        stored.filePath &&
        fs.existsSync(stored.filePath) &&
        stored.mimeType === 'application/pdf'
      ) {
        const rawBytes = fs.readFileSync(stored.filePath);
        const srcDoc = await PDFDocument.load(rawBytes, {
          ignoreEncryption: true,
        });
        const totalPages = srcDoc.getPageCount();

        if (totalPages > 12) {
          const cachedBatches = readCachedIndex(rawBytes.length);
          const coveredUntilPage =
            cachedBatches.length > 0
              ? Math.max(...cachedBatches.map((b) => b.endPage))
              : 0;

          if (coveredUntilPage < totalPages) {
            const startIdx = coveredUntilPage;
            const batchSize = 10;

            const scanSingleBatch = async (
              sIdx: number
            ): Promise<PageBatchIndex> => {
              const indices: number[] = [];
              for (
                let i = sIdx;
                i < Math.min(sIdx + batchSize, totalPages);
                i++
              ) {
                indices.push(i);
              }
              const subDoc = await PDFDocument.create();
              const copied = await subDoc.copyPages(srcDoc, indices);
              copied.forEach((p) => subDoc.addPage(p));
              const subBytes = await subDoc.save();

              const res = await callGeminiFast(
                ai,
                [
                  {
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: Buffer.from(subBytes).toString('base64'),
                    },
                  },
                  {
                    text: `Para cada uma das ${indices.length} páginas deste lote (que correspondem às páginas PDF ${indices[0] + 1} até ${indices[indices.length - 1] + 1}), retorne APENAS uma linha no formato: PAGINA_PDF|FOLHA_SELO|TITULO_E_TAGs_PRINCIPAIS (inclua tags como 52, 89, XED, 1X2, 2X2, 3XD, GMG, MSS, QGBT, UHLM, bornes, códigos RM, etc.).`,
                  },
                ],
                null,
                ThinkingLevel.MINIMAL
              );

              return {
                startPage: indices[0] + 1,
                endPage: indices[indices.length - 1] + 1,
                summary: res.text,
              };
            };

            const endRange = Math.min(startIdx + 20, totalPages);
            job.progressStep = `Mapeando índice visual do caderno PDF: páginas ${startIdx + 1} a ${endRange} de ${totalPages}...`;

            const b1 = scanSingleBatch(startIdx);
            const b2 =
              startIdx + 10 < totalPages
                ? scanSingleBatch(startIdx + 10)
                : Promise.resolve(null);
            const [r1, r2] = await Promise.all([b1, b2]);
            if (r1) cachedBatches.push(r1);
            if (r2) cachedBatches.push(r2);
            saveCachedIndex(rawBytes.length, cachedBatches);

            // If still more pages to index, return and let next poll index the next 20 pages
            if (endRange < totalPages) {
              job.isProcessingStep = false;
              return;
            }
          }
        }
      }
    }

    // 2. All PDFs are indexed! Now select relevant pages & run final diagnosis or chat
    const parts: unknown[] = [];
    const allSelectedPages: number[] = [];
    const queryText = String(
      job.payload.query || job.payload.message || ''
    );
    const focusText = String(
      job.payload.focusTopic || job.payload.diagnosticMarkdown || ''
    ).slice(0, 600);

    for (const attMeta of attachments) {
      const stored = findStoredAttachment(attMeta);
      if (stored && stored.filePath && fs.existsSync(stored.filePath)) {
        if (job.type === 'diagnose') {
          parts.push({
            text: `[ARQUIVO ANEXADO NA SEQUÊNCIA #${attMeta.sequenceIndex || 1} | Categoria: ${attMeta.categoryTag || '/EL'} | Painel: ${attMeta.panelName || 'Não informado'} | Nome: "${stored.name}"]`,
          });
        }

        if (stored.mimeType !== 'application/pdf') {
          const bytes = fs.readFileSync(stored.filePath);
          parts.push({
            inlineData: {
              mimeType: stored.mimeType,
              data: bytes.toString('base64'),
            },
          });
          allSelectedPages.push(1);
        } else {
          const rawBytes = fs.readFileSync(stored.filePath);
          const srcDoc = await PDFDocument.load(rawBytes, {
            ignoreEncryption: true,
          });
          const totalPages = srcDoc.getPageCount();

          if (totalPages <= 12) {
            parts.push({
              inlineData: {
                mimeType: 'application/pdf',
                data: rawBytes.toString('base64'),
              },
            });
            allSelectedPages.push(
              ...Array.from({ length: totalPages }, (_, i) => i + 1)
            );
          } else {
            const pageIndex = readCachedIndex(rawBytes.length);
            const fullIndexText = pageIndex
              .map(
                (b) =>
                  `=== Lote Páginas PDF ${b.startPage} a ${b.endPage} ===\n${b.summary}`
              )
              .join('\n\n');

            const selectorPrompt = `Abaixo está o índice completo das ${totalPages} páginas do caderno elétrico "${stored.name}":\n\n${fullIndexText}\n\nCONSULTA DO OPERADOR: "${queryText}"\n${focusText ? `CONTEXTO: "${focusText}"` : ''}\n\nSelecione até 8 números de PÁGINA_PDF (entre 1 e ${totalPages}) mais relevantes. Retorne APENAS os números separados por vírgula.`;

            let selectedPagesOneBased: number[] = [1, 2];
            try {
              const selRes = await callGeminiFast(
                ai,
                [{ text: selectorPrompt }],
                null,
                ThinkingLevel.MINIMAL
              );
              const matches = selRes.text.match(/\b\d+\b/g);
              if (matches && matches.length > 0) {
                const parsed = matches
                  .map((n) => parseInt(n, 10))
                  .filter((n) => n >= 1 && n <= totalPages);
                if (parsed.length > 0) {
                  selectedPagesOneBased = Array.from(
                    new Set([1, ...parsed])
                  ).slice(0, 9);
                }
              }
            } catch {
              selectedPagesOneBased = [1, 2];
            }

            const subDoc = await PDFDocument.create();
            const copied = await subDoc.copyPages(
              srcDoc,
              selectedPagesOneBased.map((p) => p - 1)
            );
            copied.forEach((p) => subDoc.addPage(p));
            const subPdfBytes = await subDoc.save();

            const pageMappingExplanation = selectedPagesOneBased
              .map(
                (origPdfPage, idx) =>
                  `Página ${idx + 1} deste recorte anexado = Página ${origPdfPage} do PDF original`
              )
              .join('; ');

            parts.push({
              text: `ÍNDICE COMPLETO DAS ${totalPages} PÁGINAS DO ARQUIVO "${stored.name}":\n${fullIndexText}\n\n[ATENÇÃO: Recorte em alta resolução anexado: ${pageMappingExplanation}. Cite SEMPRE o número da página do PDF original!]`,
            });
            parts.push({
              inlineData: {
                mimeType: 'application/pdf',
                data: Buffer.from(subPdfBytes).toString('base64'),
              },
            });
            allSelectedPages.push(...selectedPagesOneBased);
          }
        }
      }
    }

    if (job.type === 'diagnose') {
      const history = job.payload.history as Array<{
        userQuery: string;
        markdownResponse: string;
      }>;
      if (Array.isArray(history) && history.length > 0) {
        const prevSummary = history
          .map(
            (t, idx) =>
              `--- ETAPA ANTERIOR #${idx + 1} ---\nConsulta: ${t.userQuery}\nDiagnóstico:\n${t.markdownResponse}\n`
          )
          .join('\n');
        parts.push({
          text: `HISTÓRICO ACUMULADO DA INVESTIGAÇÃO:\n${prevSummary}`,
        });
      }

      let finalPromptText = String(job.payload.query || '');
      if (job.payload.focusTopic) {
        finalPromptText += `\n\nFOCO TÉCNICO SOLICITADO: ${job.payload.focusTopic}`;
      }
      if (attachments.length === 0) {
        finalPromptText += `\n\n[Nota: Nenhum arquivo PDF anexado. Forneça orientação preliminar baseada no padrão WEG/IEC/ANSI para PCH/UHE.]`;
      }
      parts.push({ text: finalPromptText });

      job.progressStep =
        'Elaborando diagnóstico detalhado (Guia de Multímetro, Procedimento de Campo, /ME e /RM)...';

      const result = await callGeminiFast(
        ai,
        parts,
        SYSTEM_INSTRUCTION,
        ThinkingLevel.LOW
      );
      const markdownText = result.text || 'Diagnóstico concluído.';
      const lowerText = markdownText.toLowerCase();

      job.status = 'completed';
      job.markdown = markdownText;
      job.requiresNextDrawing =
        lowerText.includes('subir o caderno') ||
        lowerText.includes('próximo desenho') ||
        lowerText.includes('documento externo') ||
        lowerText.includes('outro painel') ||
        lowerText.includes('sequência');
      job.inspectedPages = allSelectedPages;
      job.modelUsed = result.modelUsed;
      job.timestamp = new Date().toISOString();
    } else {
      // Chat job
      if (job.payload.inlineImageBase64 && job.payload.inlineImageMimeType) {
        parts.push({
          text: '[FOTO DE CAMPO ENVIADA PELO OPERADOR NO CHAT]:',
        });
        parts.push({
          inlineData: {
            mimeType: String(job.payload.inlineImageMimeType),
            data: String(job.payload.inlineImageBase64),
          },
        });
      }

      const chatHistory = job.payload.chatHistory as Array<{
        role: string;
        content: string;
      }>;
      const formattedHistory = Array.isArray(chatHistory)
        ? chatHistory
            .map(
              (m) =>
                `${m.role === 'user' ? 'OPERADOR' : 'ENGENHEIRO IA'}: ${m.content}`
            )
            .join('\n\n')
        : '';

      parts.push({
        text: `CONTEXTO DO LAUDO ATUAL (Alarme: "${job.payload.alarmTitle || ''}"):\n${job.payload.diagnosticMarkdown || ''}\n\n${formattedHistory ? `HISTÓRICO DO CHAT:\n${formattedHistory}\n` : ''}NOVA MENSAGEM DO OPERADOR:\n"${job.payload.message}"`,
      });

      const result = await callGeminiFast(
        ai,
        parts,
        CHAT_SYSTEM_INSTRUCTION,
        ThinkingLevel.LOW
      );
      job.status = 'completed';
      job.markdown = result.text || 'Resposta concluída.';
      job.inspectedPages = allSelectedPages;
      job.modelUsed = result.modelUsed;
      job.timestamp = new Date().toISOString();
    }
  } catch (err) {
    job.status = 'error';
    job.error =
      err instanceof Error
        ? err.message
        : 'Erro ao processar análise na Vercel.';
  } finally {
    job.isProcessingStep = false;
  }
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Stateless Serverless Step Endpoint
app.post('/api/serverless-step', async (req, res) => {
  try {
    const { action } = req.body || {};
    const ai = getGeminiClient();

    if (action === 'index_batch') {
      const { subPdfBase64, startPage, endPage, pageCount } = req.body;
      const result = await callGeminiFast(
        ai,
        [
          {
            inlineData: { mimeType: 'application/pdf', data: subPdfBase64 },
          },
          {
            text: `Para cada uma das ${pageCount} páginas deste lote (páginas PDF ${startPage} até ${endPage}), retorne APENAS uma linha: PAGINA_PDF|FOLHA_SELO|TITULO_E_TAGs_PRINCIPAIS.`,
          },
        ],
        null,
        ThinkingLevel.MINIMAL
      );
      return res.json({ summary: result.text });
    }

    if (action === 'select_pages') {
      const { fileName, totalPages, fullIndexText, userQuery, focusTopic } =
        req.body;
      const selRes = await callGeminiFast(
        ai,
        [
          {
            text: `Índice das ${totalPages} páginas de "${fileName}":\n${fullIndexText}\n\nCONSULTA: "${userQuery}"\n${focusTopic || ''}\nSelecione até 8 números de PÁGINA_PDF separados por vírgula.`,
          },
        ],
        null,
        ThinkingLevel.MINIMAL
      );
      const matches = selRes.text.match(/\b\d+\b/g);
      let selectedPages: number[] = [1, 2];
      if (matches && matches.length > 0) {
        const parsed = matches
          .map((n) => parseInt(n, 10))
          .filter((n) => n >= 1 && n <= Number(totalPages));
        if (parsed.length > 0) {
          selectedPages = Array.from(new Set([1, ...parsed])).slice(0, 9);
        }
      }
      return res.json({ selectedPages });
    }

    if (action === 'diagnose') {
      const { preparedParts, query, focusTopic, history, hasAttachments } =
        req.body;
      const parts: unknown[] = Array.isArray(preparedParts)
        ? [...preparedParts]
        : [];
      if (Array.isArray(history) && history.length > 0) {
        parts.push({
          text: `HISTÓRICO:\n${history.map((t: { userQuery: string; markdownResponse: string }, i: number) => `#${i + 1}: ${t.userQuery}\n${t.markdownResponse}`).join('\n')}`,
        });
      }
      let finalPromptText = query || '';
      if (focusTopic) finalPromptText += `\nFOCO: ${focusTopic}`;
      if (!hasAttachments) {
        finalPromptText += `\n[Nota: Nenhum PDF anexado. Forneça orientação preliminar WEG/IEC/ANSI.]`;
      }
      parts.push({ text: finalPromptText });

      const result = await callGeminiFast(
        ai,
        parts,
        SYSTEM_INSTRUCTION,
        ThinkingLevel.LOW
      );
      const markdownText = result.text || '';
      const lower = markdownText.toLowerCase();
      return res.json({
        status: 'completed',
        markdown: markdownText,
        requiresNextDrawing:
          lower.includes('próximo desenho') ||
          lower.includes('documento externo') ||
          lower.includes('sequência'),
        modelUsed: result.modelUsed,
        timestamp: new Date().toISOString(),
      });
    }

    if (action === 'chat') {
      const {
        preparedParts,
        message,
        alarmTitle,
        diagnosticMarkdown,
        chatHistory,
        inlineImageBase64,
        inlineImageMimeType,
      } = req.body;
      const parts: unknown[] = Array.isArray(preparedParts)
        ? [...preparedParts]
        : [];
      if (inlineImageBase64 && inlineImageMimeType) {
        parts.push({
          inlineData: {
            mimeType: inlineImageMimeType,
            data: inlineImageBase64,
          },
        });
      }
      const formattedChat = Array.isArray(chatHistory)
        ? chatHistory
            .map(
              (m: { role: string; content: string }) =>
                `${m.role}: ${m.content}`
            )
            .join('\n\n')
        : '';
      parts.push({
        text: `LAUDO (${alarmTitle}):\n${diagnosticMarkdown}\n\n${formattedChat}\n\nPERGUNTA DO OPERADOR: "${message}"`,
      });
      const result = await callGeminiFast(
        ai,
        parts,
        CHAT_SYSTEM_INSTRUCTION,
        ThinkingLevel.LOW
      );
      return res.json({
        status: 'completed',
        markdown: result.text || '',
        modelUsed: result.modelUsed,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Erro interno.',
    });
  }
});

// History endpoints
app.get('/api/history', (_req, res) => {
  return res.json({ items: readHistoryDb() });
});

app.post('/api/history', (req, res) => {
  const record = req.body;
  if (!record || !record.id) return res.status(400).json({ error: 'Inválido' });
  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const idx = items.findIndex((i) => i.id === record.id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...record, updatedAt: new Date().toISOString() };
  } else {
    items.unshift({ ...record, updatedAt: new Date().toISOString() });
  }
  const trimmed = items.slice(0, 100);
  writeHistoryDb(trimmed);
  return res.json({ status: 'saved', items: trimmed });
});

app.patch('/api/history/:id', (req, res) => {
  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const idx = items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  items[idx] = { ...items[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeHistoryDb(items);
  return res.json({ status: 'updated', item: items[idx], items });
});

app.delete('/api/history/:id', (req, res) => {
  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const next = items.filter((i) => i.id !== req.params.id);
  writeHistoryDb(next);
  return res.json({ status: 'deleted', items: next });
});

// Chunked Upload Endpoint
app.post('/api/upload-chunk', (req, res) => {
  try {
    const {
      attachmentId,
      name,
      mimeType,
      sizeBytes,
      chunkIndex,
      totalChunks,
      chunkData,
    } = req.body;
    let record = attachmentStore.get(attachmentId);
    if (!record) {
      record = {
        id: attachmentId,
        name: name || 'diagrama.pdf',
        mimeType: mimeType || 'application/pdf',
        sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
        totalChunks,
        receivedChunks: new Map(),
        updatedAt: Date.now(),
      };
      attachmentStore.set(attachmentId, record);
    }
    record.receivedChunks.set(chunkIndex, chunkData);
    record.updatedAt = Date.now();

    if (record.receivedChunks.size === totalChunks) {
      const ordered: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        ordered.push(record.receivedChunks.get(i) || '');
      }
      const fullBase64 = ordered.join('');
      record.completeBase64 = fullBase64;
      record.receivedChunks.clear();
      const rawBuf = Buffer.from(fullBase64, 'base64');
      record.sizeBytes = rawBuf.length;
      const safeName = `${attachmentId}_${(record.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filePath = path.join(UPLOAD_DIR, safeName);
      fs.writeFileSync(filePath, rawBuf);
      record.filePath = filePath;
      return res.json({ status: 'complete', attachmentId });
    }
    return res.json({
      status: 'chunk_received',
      attachmentId,
      received: record.receivedChunks.size,
      totalChunks,
    });
  } catch {
    return res.status(500).json({ error: 'Falha ao salvar bloco.' });
  }
});

// Diagnose Job Creation (compatible with both 15:46h frontend and latest frontend)
app.post('/api/diagnose', (req, res) => {
  const { query, attachments, focusTopic } = req.body || {};
  if (!query && !focusTopic) {
    return res.status(400).json({ error: 'Informe o alarme ou consulta.' });
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    const missingIds: string[] = [];
    for (const file of attachments) {
      if (!findStoredAttachment(file) && !file.base64Data) {
        missingIds.push(file.id);
      }
    }
    if (missingIds.length > 0) {
      return res.status(409).json({
        code: 'NEED_REUPLOAD',
        missingIds,
        error: 'Ressincronizando arquivos...',
      });
    }
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  diagnosticJobs.set(jobId, {
    id: jobId,
    type: 'diagnose',
    status: 'running',
    progressStep: 'Iniciando varredura eletromecânica dos diagramas...',
    payload: req.body || {},
    nextBatchStartPageIndex: 0,
    isProcessingStep: false,
    createdAt: Date.now(),
  });

  return res.json({ status: 'started', jobId });
});

// Chat Job Creation
app.post('/api/chat-fault', (req, res) => {
  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'Informe a pergunta.' });
  }
  const jobId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  diagnosticJobs.set(jobId, {
    id: jobId,
    type: 'chat',
    status: 'running',
    progressStep: 'Consultando folhas do diagrama para responder no chat...',
    payload: req.body || {},
    nextBatchStartPageIndex: 0,
    isProcessingStep: false,
    createdAt: Date.now(),
  });
  return res.json({ status: 'started', jobId });
});

// Poll Status Endpoint — advances 1 step synchronously on each poll so Vercel Serverless never freezes!
app.get('/api/diagnose/status/:jobId', async (req, res) => {
  const job = diagnosticJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Tarefa não encontrada.' });
  }
  if (job.status === 'running') {
    await advanceJobOneStep(job);
  }
  return res.json({
    id: job.id,
    status: job.status,
    progressStep: job.progressStep,
    markdown: job.markdown,
    requiresNextDrawing: job.requiresNextDrawing,
    inspectedPages: job.inspectedPages,
    modelUsed: job.modelUsed,
    timestamp: job.timestamp,
    error: job.error,
  });
});

export default app;
