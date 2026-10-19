import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(os.tmpdir(), 'hydrodiag_uploads');
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch {
  // Ignore on restricted environments
}

function getWritableDataDir(): string {
  if (process.env.VERCEL) {
    return UPLOAD_DIR;
  }
  const localDataDir = path.join(__dirname, 'data');
  try {
    if (!fs.existsSync(localDataDir)) {
      fs.mkdirSync(localDataDir, { recursive: true });
    }
    return localDataDir;
  } catch {
    return UPLOAD_DIR;
  }
}

const HISTORY_DB_PATH = path.join(getWritableDataDir(), 'fault_history_db.json');

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
  status: 'running' | 'completed' | 'error';
  progressStep: string;
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
const activeIndexingPromises = new Map<string, Promise<PageBatchIndex[]>>();

export const SYSTEM_INSTRUCTION = `Você é um Sistema Especialista Híbrido composto por um Engenheiro Eletricista Sênior de Manutenção/Proteção de Usinas Hidrelétricas (PCH/UHE) e um Engenheiro de Automação.
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

FORMATO OBRIGATÓRIO DE RESPOSTA:
### 🚨 1. Diagnóstico e Localização no Desenho
### 📟 2. Guia de Teste com Multímetro (Passo a Passo)
### 🛠️ 3. Como Resolver e Corrigir a Falha (Procedimento de Campo)
### 🗄️ 4. Localização Física no Painel (/ME) e Dados da Peça (/RM)
### 🔄 5. Próximo Desenho na Sequência (Se aplicável)
Caso haja novas dúvidas ou falhas, forneça o próximo diagrama detalhado.`;

export const CHAT_SYSTEM_INSTRUCTION = `Você é o Copiloto Especialista em Manutenção Eletromecânica e Automação de Usinas Hidrelétricas (PCH/UHE), conversando em tempo real com o operador/eletricista sobre uma falha em investigação.
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
      'Variável de ambiente GEMINI_API_KEY não configurada. Adicione GEMINI_API_KEY nas configurações (Environment Variables) da Vercel.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHistoryDb(): unknown[] {
  try {
    if (fs.existsSync(HISTORY_DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_DB_PATH, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore read error
  }
  return [];
}

function writeHistoryDb(items: unknown[]) {
  try {
    fs.writeFileSync(HISTORY_DB_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Erro ao salvar histórico em disco:', err);
  }
}

function preloadExistingUploadsFromDisk() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    const files = fs.readdirSync(UPLOAD_DIR);
    for (const f of files) {
      if (
        f.startsWith('att_') &&
        (f.endsWith('.pdf') || f.endsWith('.jpg') || f.endsWith('.png'))
      ) {
        const fullPath = path.join(UPLOAD_DIR, f);
        const stat = fs.statSync(fullPath);
        const parts = f.split('_');
        const id =
          parts.length >= 3 ? `${parts[0]}_${parts[1]}_${parts[2]}` : f;
        const mimeType = f.toLowerCase().endsWith('.pdf')
          ? 'application/pdf'
          : 'image/jpeg';
        attachmentStore.set(id, {
          id,
          name: parts.slice(3).join('_') || f,
          mimeType,
          sizeBytes: stat.size,
          totalChunks: 1,
          receivedChunks: new Map(),
          filePath: fullPath,
          updatedAt: stat.mtimeMs,
        });
      }
    }
  } catch {
    // Ignore disk scan errors
  }
}

preloadExistingUploadsFromDisk();

function findStoredAttachment(fileMeta: {
  id: string;
  name?: string;
  sizeBytes?: number;
  mimeType?: string;
}): StoredAttachmentRecord | undefined {
  const direct = attachmentStore.get(fileMeta.id);
  if (direct && (direct.filePath || direct.completeBase64)) {
    return direct;
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

  if (!fileMeta.id && attachmentStore.size > 0) {
    const latest = Array.from(attachmentStore.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    )[0];
    return latest;
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
    { name: 'gemini-3.8-flash', thinking: thinkingLevel },
    { name: 'gemini-3-flash-preview', thinking: thinkingLevel },
    { name: 'gemini-flash-latest', thinking: undefined },
    { name: 'gemini-3.1-flash-lite', thinking: undefined },
  ];

  let lastError: unknown = null;

  for (let round = 0; round < 2; round++) {
    for (const candidate of candidateModels) {
      try {
        const config: Record<string, unknown> = {
          temperature: 0.2,
        };
        if (systemPrompt) {
          config.systemInstruction = systemPrompt;
        }
        if (candidate.thinking) {
          config.thinkingConfig = {
            thinkingLevel: candidate.thinking,
          };
        }

        const response = await ai.models.generateContent({
          model: candidate.name,
          contents: { parts: parts as never[] },
          config,
        });

        if (response && response.text) {
          return {
            text: response.text,
            modelUsed: candidate.name,
          };
        }
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[HydroDiag AI] Modelo ${candidate.name} (rodada ${round + 1}) retornou: ${msg.slice(0, 140)}`
        );
      }
    }
    await sleep(900 * (round + 1));
  }

  throw lastError || new Error('Serviço de IA temporariamente indisponível.');
}

async function getOrCreatePdfIndex(
  ai: GoogleGenAI,
  filePath: string,
  sizeBytes: number,
  onProgress?: (msg: string) => void
): Promise<PageBatchIndex[]> {
  const indexCachePath = path.join(UPLOAD_DIR, `idx_${sizeBytes}.json`);
  if (fs.existsSync(indexCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(indexCachePath, 'utf-8'));
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  const existingPromise = activeIndexingPromises.get(indexCachePath);
  if (existingPromise) {
    if (onProgress) {
      onProgress(
        'Aguardando conclusão do mapeamento de páginas do caderno PDF...'
      );
    }
    return existingPromise;
  }

  const indexingTask = (async () => {
    const rawBytes = fs.readFileSync(filePath);
    const srcDoc = await PDFDocument.load(rawBytes);
    const totalPages = srcDoc.getPageCount();
    const batchSize = 10;
    const results: PageBatchIndex[] = [];

    const scanSingleBatch = async (
      startIdx: number
    ): Promise<PageBatchIndex> => {
      const indices: number[] = [];
      for (
        let i = startIdx;
        i < Math.min(startIdx + batchSize, totalPages);
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

    for (let s = 0; s < totalPages; s += 20) {
      const endRange = Math.min(s + 20, totalPages);
      if (onProgress) {
        onProgress(
          `Mapeando índice visual do caderno PDF: páginas ${s + 1} a ${endRange} de ${totalPages}...`
        );
      }
      const b1 = scanSingleBatch(s);
      const b2 =
        s + 10 < totalPages ? scanSingleBatch(s + 10) : Promise.resolve(null);
      const [r1, r2] = await Promise.all([b1, b2]);
      if (r1) results.push(r1);
      if (r2) results.push(r2);
    }

    try {
      fs.writeFileSync(indexCachePath, JSON.stringify(results, null, 2));
    } catch {
      // Ignore write error
    }
    activeIndexingPromises.delete(indexCachePath);
    return results;
  })();

  activeIndexingPromises.set(indexCachePath, indexingTask);
  return indexingTask;
}

async function prepareSmartPdfParts(
  ai: GoogleGenAI,
  record: StoredAttachmentRecord,
  userQuery: string,
  focusTopic: string,
  onProgress?: (msg: string) => void
): Promise<{ parts: unknown[]; selectedPages: number[] }> {
  if (!record.filePath || !fs.existsSync(record.filePath)) {
    if (record.completeBase64) {
      return {
        parts: [
          {
            inlineData: {
              mimeType: record.mimeType,
              data: record.completeBase64,
            },
          },
        ],
        selectedPages: [1],
      };
    }
    return { parts: [], selectedPages: [] };
  }

  if (record.mimeType !== 'application/pdf') {
    const bytes = fs.readFileSync(record.filePath);
    return {
      parts: [
        {
          inlineData: {
            mimeType: record.mimeType,
            data: bytes.toString('base64'),
          },
        },
      ],
      selectedPages: [1],
    };
  }

  const rawBytes = fs.readFileSync(record.filePath);
  const srcDoc = await PDFDocument.load(rawBytes);
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= 12) {
    return {
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: rawBytes.toString('base64'),
          },
        },
      ],
      selectedPages: Array.from({ length: totalPages }, (_, i) => i + 1),
    };
  }

  const pageIndex = await getOrCreatePdfIndex(
    ai,
    record.filePath,
    rawBytes.length,
    onProgress
  );

  const fullIndexText = pageIndex
    .map(
      (b) =>
        `=== Lote Páginas PDF ${b.startPage} a ${b.endPage} ===\n${b.summary}`
    )
    .join('\n\n');

  if (onProgress) {
    onProgress(
      `Localizando folhas (/EL, /RB, /ME, /RM) referentes a "${userQuery.slice(0, 45)}" nas ${totalPages} páginas...`
    );
  }

  const selectorPrompt = `Abaixo está o índice completo das ${totalPages} páginas do caderno elétrico "${record.name}":

${fullIndexText}

CONSULTA / PERGUNTA ATUAL DO OPERADOR: "${userQuery}"
${focusTopic ? `CONTEXTO ADICIONAL: "${focusTopic}"` : ''}

Selecione até 8 números de PÁGINA_PDF (entre 1 e ${totalPages}) que são mais relevantes para responder à consulta, incluindo:
- Qualquer Folha ou Página explicitamente mencionada pelo operador (ex: se ele pedir Folha 27 ou Folha 31, localize a PAGINA_PDF correspondente no índice acima!);
- A(s) folha(s) funcional(is) /EL onde aparece o alarme/componente consultado e seu comando/alimentação;
- A(s) página(s) de Desenho Mecânico (/ME), Relação de Materiais (/RM) e Régua de Bornes (/RB) associadas.

Retorne APENAS os números das páginas do PDF separados por vírgula (exemplo: 1, 29, 33, 51, 68, 75, 84).`;

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
        selectedPagesOneBased = Array.from(new Set([1, ...parsed])).slice(0, 9);
      }
    }
  } catch {
    selectedPagesOneBased = [1, 2, 48, 49, 50, 51, 68, 75];
  }

  if (onProgress) {
    onProgress(
      `Inspecionando em alta resolução as páginas PDF selecionadas (${selectedPagesOneBased.join(', ')})...`
    );
  }

  const subDoc = await PDFDocument.create();
  const zeroBasedIndices = selectedPagesOneBased.map((p) => p - 1);
  const copied = await subDoc.copyPages(srcDoc, zeroBasedIndices);
  copied.forEach((p) => subDoc.addPage(p));
  const subPdfBytes = await subDoc.save();

  const pageMappingExplanation = selectedPagesOneBased
    .map(
      (origPdfPage, idx) =>
        `Página ${idx + 1} deste recorte anexado = Página ${origPdfPage} do PDF original`
    )
    .join('; ');

  return {
    selectedPages: selectedPagesOneBased,
    parts: [
      {
        text: `ÍNDICE COMPLETO DAS ${totalPages} PÁGINAS DO ARQUIVO "${record.name}":\n${fullIndexText}\n\n[ATENÇÃO: Para análise visual de alta precisão das coordenadas (Linha A-F, Coluna 1-8), contatos NA/NF e bornes, anexamos a seguir o recorte em alta resolução contendo as páginas mais relevantes do PDF original: ${pageMappingExplanation}. Ao citar o número da página do PDF na resposta, cite SEMPRE o número da página do PDF original!]`,
      },
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: Buffer.from(subPdfBytes).toString('base64'),
        },
      },
    ],
  };
}

export function createApiApp() {
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ============================================================================
  // 0. STATELESS VERCEL SERVERLESS ENDPOINT (/api/serverless-step)
  // ============================================================================
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
              inlineData: {
                mimeType: 'application/pdf',
                data: subPdfBase64,
              },
            },
            {
              text: `Para cada uma das ${pageCount} páginas deste lote (que correspondem às páginas PDF ${startPage} até ${endPage}), retorne APENAS uma linha no formato: PAGINA_PDF|FOLHA_SELO|TITULO_E_TAGs_PRINCIPAIS (inclua tags como 52, 89, XED, 1X2, 2X2, 3XD, GMG, MSS, QGBT, UHLM, bornes, códigos RM, etc.).`,
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
        const selectorPrompt = `Abaixo está o índice completo das ${totalPages} páginas do caderno elétrico "${fileName}":

${fullIndexText}

CONSULTA / PERGUNTA ATUAL DO OPERADOR: "${userQuery}"
${focusTopic ? `CONTEXTO ADICIONAL: "${focusTopic}"` : ''}

Selecione até 8 números de PÁGINA_PDF (entre 1 e ${totalPages}) que são mais relevantes para responder à consulta, incluindo:
- Qualquer Folha ou Página explicitamente mencionada pelo operador (ex: se ele pedir Folha 27 ou Folha 31, localize a PAGINA_PDF correspondente no índice acima!);
- A(s) folha(s) funcional(is) /EL onde aparece o alarme/componente consultado e seu comando/alimentação;
- A(s) página(s) de Desenho Mecânico (/ME), Relação de Materiais (/RM) e Régua de Bornes (/RB) associadas.

Retorne APENAS os números das páginas do PDF separados por vírgula (exemplo: 1, 29, 33, 51, 68, 75, 84).`;

        const selRes = await callGeminiFast(
          ai,
          [{ text: selectorPrompt }],
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
          const previousTurnsSummary = history
            .map(
              (
                turn: { userQuery: string; markdownResponse: string },
                idx: number
              ) =>
                `--- ETAPA ANTERIOR #${idx + 1} ---\nConsulta do Operador: ${turn.userQuery}\nDiagnóstico Emitido:\n${turn.markdownResponse}\n`
            )
            .join('\n');

          parts.push({
            text: `HISTÓRICO ACUMULADO DA INVESTIGAÇÃO SEQUENCIAL ENTRE PAINÉIS:\n${previousTurnsSummary}`,
          });
        }

        let finalPromptText = query || '';
        if (focusTopic) {
          finalPromptText = finalPromptText
            ? `${finalPromptText}\n\nFOCO TÉCNICO SOLICITADO PELO OPERADOR: ${focusTopic}`
            : `FOCO TÉCNICO SOLICITADO PELO OPERADOR: ${focusTopic}`;
        }

        if (!hasAttachments) {
          finalPromptText += `\n\n[Nota: Nenhum arquivo PDF ou foto foi anexado ainda nesta consulta. Forneça orientação preliminar baseada no padrão WEG/IEC/ANSI para PCH/UHE e indique exatamente qual caderno (/EL, /RB, /ME, /RM) e painel (ex: PCPG, QDCC, CLP-SASE, UHLM) o operador deve anexar para a localização exata dos bornes.]`;
        }

        parts.push({ text: finalPromptText });

        const result = await callGeminiFast(
          ai,
          parts,
          SYSTEM_INSTRUCTION,
          ThinkingLevel.LOW
        );
        const markdownText =
          result.text ||
          'Não foi possível gerar o diagnóstico para os dados enviados.';

        const lowerText = markdownText.toLowerCase();
        const requiresNextDrawing =
          lowerText.includes('subir o caderno') ||
          lowerText.includes('próximo desenho') ||
          lowerText.includes('documento externo') ||
          lowerText.includes('outro painel') ||
          lowerText.includes('anexar') ||
          lowerText.includes('não pertence') ||
          lowerText.includes('sequência');

        return res.json({
          status: 'completed',
          markdown: markdownText,
          requiresNextDrawing,
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
            text: '[FOTO DE CAMPO / MEDIÇÃO ENVIADA PELO OPERADOR NO CHAT]:',
          });
          parts.push({
            inlineData: {
              mimeType: inlineImageMimeType,
              data: inlineImageBase64,
            },
          });
        }

        const formattedChatHistory = Array.isArray(chatHistory)
          ? chatHistory
              .map(
                (m: { role: string; content: string }) =>
                  `${m.role === 'user' ? 'OPERADOR EM CAMPO' : 'ENGENHEIRO ESPECIALISTA (IA)'}: ${m.content}`
              )
              .join('\n\n')
          : '';

        parts.push({
          text: `CONTEXTO DO LAUDO TÉCNICO ATUAL (Alarme: "${alarmTitle || 'Em investigação'}"):
${diagnosticMarkdown || 'Sem laudo inicial.'}

${formattedChatHistory ? `HISTÓRICO DA CONVERSA NO CHAT:\n${formattedChatHistory}\n` : ''}
NOVA MENSAGEM DO OPERADOR EM CAMPO:
"${message}"

Responda em Markdown técnico claro, objetivo e direto para auxiliar o operador em campo.`,
        });

        const result = await callGeminiFast(
          ai,
          parts,
          CHAT_SYSTEM_INSTRUCTION,
          ThinkingLevel.LOW
        );

        return res.json({
          status: 'completed',
          markdown:
            result.text || 'Não foi possível processar a resposta do chat.',
          modelUsed: result.modelUsed,
          timestamp: new Date().toISOString(),
        });
      }

      return res.status(400).json({ error: 'Ação serverless desconhecida.' });
    } catch (err) {
      console.error('Erro em /api/serverless-step:', err);
      return res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao processar requisição na função serverless.',
      });
    }
  });

  // ============================================================================
  // 1. PERSISTENT FAULT HISTORY DATABASE API (/api/history)
  // ============================================================================
  app.get('/api/history', (req, res) => {
    const items = readHistoryDb() as Array<Record<string, unknown>>;
    const search = String(req.query.q || '')
      .trim()
      .toLowerCase();
    const statusFilter = String(req.query.status || '').trim();

    const filtered = items.filter((item) => {
      if (statusFilter && statusFilter !== 'todos') {
        if (statusFilter === 'favoritos' && !item.isFavorite) return false;
        if (statusFilter !== 'favoritos' && item.status !== statusFilter)
          return false;
      }
      if (!search) return true;
      const blob = JSON.stringify(item).toLowerCase();
      return blob.includes(search);
    });

    return res.json({ items: filtered });
  });

  app.post('/api/history', (req, res) => {
    try {
      const record = req.body;
      if (!record || !record.id) {
        return res.status(400).json({ error: 'Registro inválido.' });
      }
      const items = readHistoryDb() as Array<Record<string, unknown>>;
      const existingIndex = items.findIndex((i) => i.id === record.id);
      if (existingIndex >= 0) {
        items[existingIndex] = {
          ...items[existingIndex],
          ...record,
          updatedAt: new Date().toISOString(),
        };
      } else {
        items.unshift({
          status: 'em_investigacao',
          isFavorite: false,
          ...record,
          updatedAt: new Date().toISOString(),
        });
      }
      const trimmed = items.slice(0, 100);
      writeHistoryDb(trimmed);
      return res.json({ status: 'saved', items: trimmed });
    } catch (err) {
      console.error('Erro ao salvar histórico:', err);
      return res.status(500).json({ error: 'Erro ao salvar histórico.' });
    }
  });

  app.patch('/api/history/:id', (req, res) => {
    const { id } = req.params;
    const updates = req.body || {};
    const items = readHistoryDb() as Array<Record<string, unknown>>;
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }
    items[idx] = {
      ...items[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    writeHistoryDb(items);
    return res.json({ status: 'updated', item: items[idx], items });
  });

  app.delete('/api/history/:id', (req, res) => {
    const { id } = req.params;
    const items = readHistoryDb() as Array<Record<string, unknown>>;
    const next = items.filter((i) => i.id !== id);
    writeHistoryDb(next);
    return res.json({ status: 'deleted', items: next });
  });

  // ============================================================================
  // 2. CHUNKED PDF / PHOTO UPLOAD API (/api/upload-chunk)
  // ============================================================================
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

      if (
        !attachmentId ||
        typeof chunkIndex !== 'number' ||
        typeof totalChunks !== 'number' ||
        typeof chunkData !== 'string'
      ) {
        return res.status(400).json({
          error: 'Parâmetros de bloco de upload inválidos.',
        });
      }

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
        const orderedChunks: string[] = [];
        for (let i = 0; i < totalChunks; i++) {
          orderedChunks.push(record.receivedChunks.get(i) || '');
        }
        const fullBase64 = orderedChunks.join('');
        record.completeBase64 = fullBase64;
        record.receivedChunks.clear();

        const rawBuf = Buffer.from(fullBase64, 'base64');
        record.sizeBytes = rawBuf.length;
        const safeName = `${attachmentId}_${(record.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(UPLOAD_DIR, safeName);
        fs.writeFileSync(filePath, rawBuf);
        record.filePath = filePath;

        return res.json({
          status: 'complete',
          attachmentId,
        });
      }

      return res.json({
        status: 'chunk_received',
        attachmentId,
        received: record.receivedChunks.size,
        totalChunks,
      });
    } catch (err) {
      console.error('Erro em /api/upload-chunk:', err);
      return res.status(500).json({
        error: 'Falha ao receber bloco do arquivo no servidor.',
      });
    }
  });

  // ============================================================================
  // 3. ASYNC MULTIMODAL DIAGNOSIS ENGINE (/api/diagnose)
  // ============================================================================
  app.post('/api/diagnose', async (req, res) => {
    try {
      const { query, attachments, history, focusTopic } = req.body;

      if (!query && !focusTopic) {
        return res.status(400).json({
          error:
            'Informe o alarme do supervisório, sintoma observado em campo ou selecione uma ação rápida.',
        });
      }

      if (Array.isArray(attachments) && attachments.length > 0) {
        const missingIds: string[] = [];
        for (const file of attachments) {
          const stored = findStoredAttachment(file);
          if (!stored && !file.base64Data) {
            missingIds.push(file.id);
          }
        }
        if (missingIds.length > 0) {
          return res.status(409).json({
            code: 'NEED_REUPLOAD',
            missingIds,
            error: 'Sincronizando arquivos com o servidor para análise...',
          });
        }
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job: DiagnosticJob = {
        id: jobId,
        status: 'running',
        progressStep:
          'Iniciando varredura eletromecânica dos diagramas anexados...',
        createdAt: Date.now(),
      };
      diagnosticJobs.set(jobId, job);

      (async () => {
        try {
          const ai = getGeminiClient();
          const parts: unknown[] = [];
          const allSelectedPages: number[] = [];

          if (Array.isArray(attachments) && attachments.length > 0) {
            for (const file of attachments) {
              let stored = findStoredAttachment(file);
              if (!stored && file.base64Data) {
                const rawBuf = Buffer.from(file.base64Data, 'base64');
                const safeName = `${file.id}_${(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                const filePath = path.join(UPLOAD_DIR, safeName);
                fs.writeFileSync(filePath, rawBuf);
                stored = {
                  id: file.id,
                  name: file.name,
                  mimeType: file.mimeType,
                  sizeBytes: rawBuf.length,
                  totalChunks: 1,
                  receivedChunks: new Map(),
                  completeBase64: file.base64Data,
                  filePath,
                  updatedAt: Date.now(),
                };
                attachmentStore.set(file.id, stored);
              }

              if (stored) {
                parts.push({
                  text: `[ARQUIVO ANEXADO NA SEQUÊNCIA #${file.sequenceIndex} | Categoria: ${file.categoryTag} | Painel: ${file.panelName || 'Não informado'} | Nome: "${file.name}"]`,
                });
                const { parts: docParts, selectedPages } =
                  await prepareSmartPdfParts(
                    ai,
                    stored,
                    query || '',
                    focusTopic || '',
                    (progressMsg) => {
                      job.progressStep = progressMsg;
                    }
                  );
                parts.push(...docParts);
                allSelectedPages.push(...selectedPages);
              }
            }
          }

          if (Array.isArray(history) && history.length > 0) {
            const previousTurnsSummary = history
              .map(
                (
                  turn: { userQuery: string; markdownResponse: string },
                  idx: number
                ) =>
                  `--- ETAPA ANTERIOR #${idx + 1} ---\nConsulta do Operador: ${turn.userQuery}\nDiagnóstico Emitido:\n${turn.markdownResponse}\n`
              )
              .join('\n');

            parts.push({
              text: `HISTÓRICO ACUMULADO DA INVESTIGAÇÃO SEQUENCIAL ENTRE PAINÉIS:\n${previousTurnsSummary}`,
            });
          }

          let finalPromptText = query || '';
          if (focusTopic) {
            finalPromptText = finalPromptText
              ? `${finalPromptText}\n\nFOCO TÉCNICO SOLICITADO PELO OPERADOR: ${focusTopic}`
              : `FOCO TÉCNICO SOLICITADO PELO OPERADOR: ${focusTopic}`;
          }

          if (!Array.isArray(attachments) || attachments.length === 0) {
            finalPromptText += `\n\n[Nota: Nenhum arquivo PDF ou foto foi anexado ainda nesta consulta. Forneça orientação preliminar baseada no padrão WEG/IEC/ANSI para PCH/UHE e indique exatamente qual caderno (/EL, /RB, /ME, /RM) e painel (ex: PCPG, QDCC, CLP-SASE, UHLM) o operador deve anexar para a localização exata dos bornes.]`;
          }

          parts.push({
            text: finalPromptText,
          });

          job.progressStep =
            'Elaborando diagnóstico detalhado (Guia de Multímetro, Procedimento de Campo, /ME e /RM)...';

          const result = await callGeminiFast(
            ai,
            parts,
            SYSTEM_INSTRUCTION,
            ThinkingLevel.LOW
          );
          const markdownText =
            result.text ||
            'Não foi possível gerar o diagnóstico para os dados enviados.';

          const lowerText = markdownText.toLowerCase();
          const requiresNextDrawing =
            lowerText.includes('subir o caderno') ||
            lowerText.includes('próximo desenho') ||
            lowerText.includes('documento externo') ||
            lowerText.includes('outro painel') ||
            lowerText.includes('anexar') ||
            lowerText.includes('não pertence') ||
            lowerText.includes('sequência');

          job.status = 'completed';
          job.markdown = markdownText;
          job.requiresNextDrawing = requiresNextDrawing;
          job.inspectedPages = allSelectedPages;
          job.modelUsed = result.modelUsed;
          job.timestamp = new Date().toISOString();
        } catch (err) {
          console.error('Erro no job de diagnóstico:', err);
          const rawMessage =
            err instanceof Error
              ? err.message
              : 'Erro interno ao processar o diagnóstico eletromecânico.';
          job.status = 'error';
          job.error = `Falha ao analisar os diagramas: ${rawMessage}`;
        }
      })();

      return res.json({
        status: 'started',
        jobId,
      });
    } catch (err) {
      console.error('Erro ao iniciar /api/diagnose:', err);
      return res.status(500).json({
        error: 'Não foi possível iniciar a tarefa de diagnóstico.',
      });
    }
  });

  // ============================================================================
  // 4. INTERACTIVE GEMINI ENGINEERING CHAT ON ACTIVE FAULT (/api/chat-fault)
  // ============================================================================
  app.post('/api/chat-fault', async (req, res) => {
    try {
      const {
        message,
        alarmTitle,
        diagnosticMarkdown,
        chatHistory,
        attachments,
        inlineImageBase64,
        inlineImageMimeType,
      } = req.body;

      if (!message || !String(message).trim()) {
        return res
          .status(400)
          .json({ error: 'Digite uma pergunta ou observação de campo.' });
      }

      const jobId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job: DiagnosticJob = {
        id: jobId,
        status: 'running',
        progressStep:
          'Consultando diagramas e histórico da falha para responder no chat...',
        createdAt: Date.now(),
      };
      diagnosticJobs.set(jobId, job);

      (async () => {
        try {
          const ai = getGeminiClient();
          const parts: unknown[] = [];
          const inspectedPages: number[] = [];

          const attList =
            Array.isArray(attachments) && attachments.length > 0
              ? attachments
              : [{}];

          for (const fileMeta of attList) {
            const stored = findStoredAttachment(fileMeta);
            if (stored) {
              const { parts: docParts, selectedPages } =
                await prepareSmartPdfParts(
                  ai,
                  stored,
                  `${alarmTitle || ''} - ${message}`,
                  diagnosticMarkdown
                    ? diagnosticMarkdown.slice(0, 600)
                    : '',
                  (msg) => {
                    job.progressStep = msg;
                  }
                );
              parts.push(...docParts);
              inspectedPages.push(...selectedPages);
            }
          }

          if (inlineImageBase64 && inlineImageMimeType) {
            parts.push({
              text: '[FOTO DE CAMPO / MEDIÇÃO ENVIADA PELO OPERADOR NO CHAT]:',
            });
            parts.push({
              inlineData: {
                mimeType: inlineImageMimeType,
                data: inlineImageBase64,
              },
            });
          }

          const formattedChatHistory = Array.isArray(chatHistory)
            ? chatHistory
                .map(
                  (m: { role: string; content: string }) =>
                    `${m.role === 'user' ? 'OPERADOR EM CAMPO' : 'ENGENHEIRO ESPECIALISTA (IA)'}: ${m.content}`
                )
                .join('\n\n')
            : '';

          parts.push({
            text: `CONTEXTO DO LAUDO TÉCNICO ATUAL (Alarme: "${alarmTitle || 'Em investigação'}"):
${diagnosticMarkdown || 'Sem laudo inicial.'}

${formattedChatHistory ? `HISTÓRICO DA CONVERSA NO CHAT:\n${formattedChatHistory}\n` : ''}
NOVA MENSAGEM DO OPERADOR EM CAMPO:
"${message}"

Responda em Markdown técnico claro, objetivo e direto para auxiliar o operador em campo.`,
          });

          job.progressStep =
            'Analisando circuito e formulando resposta técnica do especialista...';

          const result = await callGeminiFast(
            ai,
            parts,
            CHAT_SYSTEM_INSTRUCTION,
            ThinkingLevel.LOW
          );

          job.status = 'completed';
          job.markdown =
            result.text || 'Não foi possível processar a resposta do chat.';
          job.inspectedPages = inspectedPages;
          job.modelUsed = result.modelUsed;
          job.timestamp = new Date().toISOString();
        } catch (err) {
          console.error('Erro em /api/chat-fault:', err);
          job.status = 'error';
          job.error =
            err instanceof Error
              ? err.message
              : 'Erro ao responder no chat técnico.';
        }
      })();

      return res.json({ status: 'started', jobId });
    } catch {
      return res
        .status(500)
        .json({ error: 'Falha ao iniciar resposta do chat.' });
    }
  });

  // ============================================================================
  // 5. JOB STATUS POLLING ENDPOINT (/api/diagnose/status/:jobId)
  // ============================================================================
  app.get('/api/diagnose/status/:jobId', (req, res) => {
    const job = diagnosticJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        error: 'Tarefa de diagnóstico não encontrada.',
      });
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

  // ============================================================================
  // 6. DIRECT GITHUB REPOSITORY PUBLISHER FOR https://github.com/marcondi
  // ============================================================================
  app.post('/api/github/publish', async (req, res) => {
    try {
      const {
        githubUsername = 'marcondi',
        repoName = 'hydrodiag-ai-pch-uhe',
        githubToken,
        isPrivate = false,
      } = req.body;

      if (!githubToken || !String(githubToken).trim()) {
        return res.status(400).json({
          error:
            'Informe seu Personal Access Token (PAT) do GitHub com permissão "repo" para publicar diretamente.',
        });
      }

      const token = String(githubToken).trim();
      const owner = String(githubUsername).trim() || 'marcondi';
      const cleanRepo =
        String(repoName)
          .trim()
          .replace(/[^a-zA-Z0-9._-]/g, '-') || 'hydrodiag-ai-pch-uhe';

      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'HydroDiag-AI-Publisher',
      };

      const checkRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepo}`,
        { headers }
      );

      if (checkRes.status === 404) {
        const createRes = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: cleanRepo,
            description:
              'HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas para Usinas Hidrelétricas (PCH/UHE)',
            private: Boolean(isPrivate),
            auto_init: true,
          }),
        });

        if (!createRes.ok) {
          const errBody = await createRes.text();
          return res.status(createRes.status).json({
            error: `Não foi possível criar o repositório no GitHub: ${errBody.slice(0, 200)}`,
          });
        }
        await sleep(1500);
      } else if (!checkRes.ok) {
        const errBody = await checkRes.text();
        return res.status(checkRes.status).json({
          error: `Falha ao autenticar no GitHub (${checkRes.status}): verifique se o seu Token possui permissão 'repo'. Detalhe: ${errBody.slice(0, 160)}`,
        });
      }

      const filesToPublish = [
        'package.json',
        'vercel.json',
        'api/index.ts',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
        'metadata.json',
        '.env.example',
        '.gitignore',
        'server.ts',
        'src/main.tsx',
        'src/index.css',
        'src/types.ts',
        'src/App.tsx',
        'src/utils/pdfClientEngine.ts',
        'src/components/DiagramUploadPanel.tsx',
        'src/components/FaultQueryPanel.tsx',
        'src/components/DiagnosticReportView.tsx',
        'src/components/FaultChatPanel.tsx',
        'src/components/GitHubDeployModal.tsx',
      ];

      const readmeContent = `# ⚡ HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas (PCH / UHE)

Sistema especialista multimodal desenvolvido para engenharia de manutenção, proteção e automação de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 🚀 Funcionalidades Principais
- **Leitura Multimodal de Cadernos Elétricos (100+ páginas):** Indexação automática e recorte cirúrgico de diagramas funcionais (\`/EL\`), réguas de bornes (\`/RB\`), layout mecânico (\`/ME\`) e relação de materiais (\`/RM\`) no padrão WEG / IEC / ANSI.
- **Guia Prático de Ponta de Prova (Multímetro):** Indicação exata de réguas de bornes (\`1X2\`, \`2X2\`, \`3XD\`, \`XED\`), terminais (\`13-14\`, \`21-22\`) e tensões esperadas (\`125 Vcc\`, \`24 Vcc\`, \`220 Vca\`).
- **Chat Técnico Contínuo com o Especialista Gemini:** Converse em tempo real sobre a falha, envie fotos de medições em campo e peça análise de folhas complementares sem perder o contexto.
- **Banco de Dados Persistente de Histórico de Falhas:** Busque rapidamente diagnósticos anteriores, registre a solução confirmada em campo e exporte Ordens de Serviço.

## ☁️ Como Publicar na Vercel (Acesso em Qualquer PC)
1. Acesse [https://vercel.com/new](https://vercel.com/new) e importe este repositório (\`hydrodiag-ai-pch-uhe\`).
2. Em **Environment Variables**, adicione:
   - Nome: \`GEMINI_API_KEY\`
   - Valor: Sua chave da API do Google Gemini (obtenha gratuitamente em [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
3. Clique em **Deploy**. O arquivo \`vercel.json\` e a função serverless \`api/index.ts\` já configuram automaticamente o backend e o frontend!
`;

      const uploadedFiles: string[] = [];

      const pushSingleFile = async (relPath: string, contentBase64: string) => {
        const rawBuf = Buffer.from(contentBase64, 'base64');
        const localBlobSha = crypto
          .createHash('sha1')
          .update(`blob ${rawBuf.length}\0`)
          .update(rawBuf)
          .digest('hex');

        let existingSha: string | undefined;
        const getFileRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepo}/contents/${relPath}`,
          { headers }
        );
        if (getFileRes.ok) {
          const fileInfo = (await getFileRes.json()) as { sha?: string };
          existingSha = fileInfo.sha;
        }

        // Skip PUT if the file on GitHub is already byte-for-byte identical
        if (existingSha && existingSha === localBlobSha) {
          uploadedFiles.push(relPath);
          return;
        }

        const putRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepo}/contents/${relPath}`,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              message: `feat: update ${relPath} for Gemini 3.8 Flash & Vercel`,
              content: contentBase64,
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          }
        );
        if (putRes.ok) {
          uploadedFiles.push(relPath);
        }
      };

      await pushSingleFile(
        'README.md',
        Buffer.from(readmeContent, 'utf-8').toString('base64')
      );

      for (const relPath of filesToPublish) {
        const absPath = path.join(__dirname, relPath);
        if (fs.existsSync(absPath)) {
          const raw = fs.readFileSync(absPath);
          await pushSingleFile(relPath, raw.toString('base64'));
        }
      }

      return res.json({
        status: 'published',
        repoUrl: `https://github.com/${owner}/${cleanRepo}`,
        uploadedCount: uploadedFiles.length,
        uploadedFiles,
      });
    } catch (err) {
      console.error('Erro ao publicar no GitHub:', err);
      return res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao publicar arquivos no GitHub.',
      });
    }
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({
      error: 'Rota de API não encontrada no servidor.',
    });
  });

  return app;
}

async function startLocalOrCloudRunServer() {
  const app = createApiApp();
  const PORT = 3000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HydroDiag AI server running on http://localhost:${PORT}`);
  });
}

// Start server when running directly (AI Studio / local dev / Cloud Run), skip listen when imported by Vercel Serverless
if (!process.env.VERCEL) {
  startLocalOrCloudRunServer();
}
