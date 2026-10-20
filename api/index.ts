import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
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
Caso haja novas dúvidas ou falhas, forneça o próximo diagrama detalhado.
IMPORTANTE SOBRE SÍMBOLOS ELÉTRICOS: Use SEMPRE símbolos Unicode diretos (Ω, kΩ, MΩ, μF, μA, ±, ≈, ×, Δ, φ, °C, ∞) e escreva por extenso "menor que" e "maior que" em vez de usar os símbolos < e > (ex: "menor que 2 Ω", "maior que 1 kΩ"). NUNCA use código LaTeX com cifrões como $\\Omega$ ou $\\text{k}\\Omega$.`;

const CHAT_SYSTEM_INSTRUCTION = `Você é um Engenheiro Eletricista Sênior Especialista em Instalações Hidrelétricas (PCH e UHE), Proteção de Sistemas de Potência, Comissionamento e Automação Industrial (padrões WEG, IEC, ANSI/IEEE e NR-10).
Você está atuando em tempo real na bancada/campo junto com o eletricista ou operador da usina para investigar, isolar e solucionar falhas elétricas, eletromecânicas e de automação.

COMO VOCÊ AGE, PENSA E TOMA DECISÕES (MENTALIDADE DE ENGENHEIRO DE USINA HIDRELÉTRICA):
1. RACIOCÍNIO DE ENGENHARIA E VISÃO SISTÊMICA DA PLANTA:
   - Pense sempre na interdependência dos subsistemas da hidrelétrica:
     • Geração e Média Tensão (Gerador Síncrono, Disjuntor de Máquina 52G, Seccionadoras 89, TPs/TCs, Cubículos MT, Relés de Proteção SEL/SEPAM/MiCOM e funções ANSI: 86 Bloqueio, 87G Diferencial, 50/51 Sobrecorrente, 27/59 Tensão, 32 Potência Reversa, 40 Perda de Campo, 64G/64F Falta à Terra, 25 Sincronismo);
     • Sistemas Hidromecânicos e Regulação (Unidade Hidráulica UHLM, Regulador de Velocidade RV, Distribuidor/Comportas, Excitação SRV, pressostatos 63, nível 71, temperaturas PT100 de mancais Guia/Escora 38, solenoides de manobra);
     • Serviços Auxiliares CC (Barramento 125 Vcc de comando/proteção, 24 Vcc de automação, retificadores, bancos de baterias, supervisão e caça de Fuga à Terra no positivo/negativo CC, seletividade de fusíveis/minidisjuntores XF/DJ) e Serviços Auxiliares CA (QDSA, QDCC, QDF, GMG);
     • Automação e Supervisório (Painéis PCPG, CLP-SASE, UCR, cartões de Entrada Digital XED/DI, Saída Digital XSD/DO, Analógicas 4-20 mA, relés de interface, redes ópticas/switches).

2. SEGURANÇA OPERACIONAL (NR-10) E AVALIAÇÃO DE RISCO DE TRIP NA USINA:
   - Antes de recomendar abrir bornes, retirar fusíveis (XF) ou injetar/medir sinais, avalie e alerte sobre o impacto operacional: informe se o teste é seguro com a Unidade Geradora sincronizada/rodando ou se há risco de disparo acidental (Trip por relé 86 / bobina de abertura) ou perda de alimentação crítica.
   - Em medições de resistência/continuidade (Ω) ou megagem (MΩ), exija sempre a desenergização prévia do trecho (abertura da gaveta XF ou disjuntor) para proteger o operador e o instrumento. Em circuitos energizados, oriente medição de tensão (Vcc / Vca) em relação ao barramento negativo (0V1 / 0Vcc) ou terra.

3. MÉTODO DE DIAGNÓSTICO E TOMADA DE DECISÃO TÉCNICA ("DIVISÃO DE CIRCUITO"):
   - Não dê respostas genéricas. Analise o diagrama funcional (/EL), régua de bornes (/RB), layout mecânico (/ME) e lista de materiais (/RM) e TOME DECISÕES TÉCNICAS CLARAS em formato de árvore de decisão:
     • Hipótese Técnica Principal: O que está ocorrendo eletricamente no circuito analisado (citando Folha, Página do PDF, Coordenada Linha/Coluna, TAG, Régua de Bornes, Anilha e Terminais NA/NF ou A1-A2).
     • Passo de Medição em Campo: Onde posicionar a ponta de prova vermelha (+) e a preta (-), qual escala usar no multímetro e qual o estado esperado do circuito.
     • Tomada de Decisão (Se Medição = Valor X vs. Valor Y):
       - Se medir o valor esperado (ex: 125 Vcc ou continuidade menor que 2 Ω): conclua qual trecho está íntegro e decida exatamente qual o próximo ponto a jusante testar.
       - Se medir valor anormal (ex: 0 Vcc, tensão flutuante de fuga à terra ou circuito aberto maior que 1 kΩ): cravar qual componente, cabo de campo ou cartão XED falhou e ordenar a ação corretiva imediata (substituição com código /RM, limpeza/rearme, isolamento de fuga ou manobra segura).

VOCÊ TEM ACESSO DIRETO A TODOS OS ARQUIVOS ANEXADOS NA REQUISIÇÃO MULTIMODAL:
1. O(s) índice(s) completo(s) de páginas e os recortes em alta resolução dos cadernos elétricos em PDF (\`/EL\`, \`/RB\`, \`/ME\`, \`/RM\`), incluindo novos PDFs que o operador anexar durante a conversa no chat;
2. Qualquer foto de campo, medição de multímetro, disjuntor, régua de bornes ou cartão de CLP (\`inlineData\` de imagem) anexada pelo operador no chat;
3. O histórico do diagnóstico e da conversa.

REGRA CRÍTICA SOBRE ARQUIVOS E FOTOS ENVIADOS NO CHAT:
- **JAMAIS** diga que "o arquivo não veio anexado", "a foto não apareceu anexada no fluxo da conversa" ou "a interface do chat ocultou o arquivo".
- Sempre que houver um bloco \`inlineData\` (imagem ou PDF) ou um \`ÍNDICE COMPLETO DAS PÁGINAS\` na requisição, o arquivo JÁ ESTÁ PRESENTE E VISÍVEL para você! Analise-o imediatamente em detalhes (lendo componentes, bornes, cabos, portas de switch, ponteiras de multímetro, disjuntores, etc.).
- SÍMBOLOS ELÉTRICOS E UNIDADES: Escreva SEMPRE os símbolos elétricos diretamente em Unicode limpo (ex: \`Ω\`, \`kΩ\`, \`MΩ\`, \`μF\`, \`±\`, \`≈\`, \`Δ\`, \`φ\`, \`°C\`, \`∞\`) e escreva por extenso \`menor que\` e \`maior que\` no lugar dos símbolos \`<\` e \`>\` (ex: \`menor que 2 Ω\`, \`maior que 1 kΩ\`). NUNCA use notação LaTeX como \`$\\Omega$\` ou \`$\\text{k}\\Omega$\`.`;

function sanitizeChatHistoryItem(content: string): string {
  return content
    .replace(/[^\n]*n[ãa]o veio anexad[oa][^\n]*/gi, '')
    .replace(/[^\n]*foto n[ãa]o apareceu anexada[^\n]*/gi, '')
    .replace(/[^\n]*interface do chat [àa]s vezes pode ocultar[^\n]*/gi, '')
    .replace(/[^\n]*sistema de chat [àa]s vezes n[ãa]o carrega[^\n]*/gi, '')
    .trim();
}

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
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
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

// ============================================================================
// SUPABASE CLOUD PERSISTENCE ENGINE (Project: "Agenda Financeira youware")
// Table: public.hydrodiag_investigations
// ============================================================================
const SUPABASE_TABLE = 'hydrodiag_investigations';
const SUPABASE_PROJECT_LABEL = 'Agenda Financeira youware';

function normalizeSupabaseUrl(inputUrl: string): string {
  const trimmed = inputUrl.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('SEU_PROJECT_ID')) {
    return 'https://oooegbbvrwifilavlvgt.supabase.co';
  }
  const dashMatch = trimmed.match(
    /supabase\.com\/dashboard\/project\/([a-z0-9]+)/i
  );
  if (dashMatch && dashMatch[1]) {
    return `https://${dashMatch[1]}.supabase.co`;
  }
  if (/^[a-z0-9]{15,30}$/i.test(trimmed)) {
    return `https://${trimmed}.supabase.co`;
  }
  return trimmed;
}

function getSupabaseConfig(): { url: string; key: string } | null {
  const rawUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    'https://oooegbbvrwifilavlvgt.supabase.co';
  const rawKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';

  const url = normalizeSupabaseUrl(rawUrl);
  const key = rawKey.trim();

  if (!url || !key || key.includes('SUA_CHAVE')) {
    return null;
  }
  return { url, key };
}

function getSupabaseHeaders(key: string, extra?: Record<string, string>) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function investigationToSupabaseRow(record: Record<string, unknown>) {
  const nowIso = new Date().toISOString();
  return {
    id: String(record.id || `inv_${Date.now()}`),
    title: String(record.title || 'Diagnóstico Eletromecânico PCH/UHE'),
    status: String(record.status || 'em_investigacao'),
    is_favorite: Boolean(record.isFavorite),
    field_resolution_note: String(record.fieldResolutionNote || ''),
    created_at: String(record.createdAt || nowIso),
    updated_at: String(record.updatedAt || nowIso),
    attachment_metadata: Array.isArray(record.attachmentMetadata)
      ? record.attachmentMetadata
      : [],
    turns: Array.isArray(record.turns) ? record.turns : [],
    raw_payload: record,
  };
}

function supabaseRowToInvestigation(
  row: Record<string, unknown>
): Record<string, unknown> {
  const rawPayload =
    row.raw_payload && typeof row.raw_payload === 'object'
      ? (row.raw_payload as Record<string, unknown>)
      : {};

  return {
    ...rawPayload,
    id: String(row.id || rawPayload.id || ''),
    title: String(
      row.title || rawPayload.title || 'Diagnóstico Eletromecânico PCH/UHE'
    ),
    status: String(row.status || rawPayload.status || 'em_investigacao'),
    isFavorite:
      typeof row.is_favorite === 'boolean'
        ? row.is_favorite
        : Boolean(rawPayload.isFavorite),
    fieldResolutionNote: String(
      row.field_resolution_note ?? rawPayload.fieldResolutionNote ?? ''
    ),
    createdAt: String(
      row.created_at || rawPayload.createdAt || new Date().toISOString()
    ),
    updatedAt: String(
      row.updated_at || rawPayload.updatedAt || new Date().toISOString()
    ),
    attachmentMetadata: Array.isArray(row.attachment_metadata)
      ? row.attachment_metadata
      : Array.isArray(rawPayload.attachmentMetadata)
        ? rawPayload.attachmentMetadata
        : [],
    turns: Array.isArray(row.turns)
      ? row.turns
      : Array.isArray(rawPayload.turns)
        ? rawPayload.turns
        : [],
  };
}

async function fetchHistoryFromSupabase(): Promise<{
  ok: boolean;
  items: Array<Record<string, unknown>>;
  error?: string;
}> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, items: [] };

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?select=*&order=updated_at.desc&limit=100`,
      {
        method: 'GET',
        headers: getSupabaseHeaders(cfg.key),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, items: [], error: errText.slice(0, 200) };
    }

    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const items = Array.isArray(rows)
      ? rows.map(supabaseRowToInvestigation)
      : [];
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : 'Erro de rede no Supabase',
    };
  }
}

async function upsertHistoryToSupabase(
  records: Array<Record<string, unknown>>
): Promise<boolean> {
  const cfg = getSupabaseConfig();
  if (!cfg || records.length === 0) return false;

  try {
    const rows = records.map(investigationToSupabaseRow);
    const res = await fetch(
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?on_conflict=id`,
      {
        method: 'POST',
        headers: getSupabaseHeaders(cfg.key, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify(rows),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteHistoryFromSupabase(id: string): Promise<boolean> {
  const cfg = getSupabaseConfig();
  if (!cfg || !id) return false;

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: getSupabaseHeaders(cfg.key),
      }
    );
    return res.ok;
  } catch {
    return false;
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout (${ms}ms) em ${label}`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Prioritizes the fastest active Gemini Flash models with ThinkingLevel.MINIMAL
 * and per-attempt timeout so Vercel serverless functions NEVER exceed 60s.
 */
async function callGeminiFast(
  ai: GoogleGenAI,
  parts: unknown[],
  systemPrompt: string | null,
  thinkingLevel: ThinkingLevel = ThinkingLevel.MINIMAL,
  preferUltraFastLite = false
): Promise<{ text: string; modelUsed: string }> {
  const candidateModels = preferUltraFastLite
    ? [
        'gemini-3.1-flash-lite',
        'gemini-flash-lite-latest',
        'gemini-3-flash-preview',
        'gemini-flash-latest',
        'gemini-3.8-flash',
      ]
    : [
        'gemini-3-flash-preview',
        'gemini-flash-latest',
        'gemini-3.8-flash',
        'gemini-3.1-flash-lite',
        'gemini-flash-lite-latest',
      ];

  let lastError: unknown = null;
  const perAttemptTimeoutMs = preferUltraFastLite ? 18000 : 25000;

  for (const modelName of candidateModels) {
    try {
      const config: Record<string, unknown> = { temperature: 0.2 };
      if (systemPrompt) config.systemInstruction = systemPrompt;
      if (modelName.startsWith('gemini-3')) {
        config.thinkingConfig = {
          thinkingLevel: thinkingLevel || ThinkingLevel.MINIMAL,
        };
      }

      const response = await withTimeout(
        ai.models.generateContent({
          model: modelName,
          contents: { parts: parts as never[] },
          config,
        }),
        perAttemptTimeoutMs,
        modelName
      );
      if (response && response.text) {
        return { text: response.text, modelUsed: modelName };
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // If thinkingConfig was rejected by a specific model alias, retry once without thinkingConfig
      if (msg.toLowerCase().includes('thinking')) {
        try {
          const fallbackConfig: Record<string, unknown> = { temperature: 0.2 };
          if (systemPrompt) fallbackConfig.systemInstruction = systemPrompt;
          const retryRes = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: { parts: parts as never[] },
              config: fallbackConfig,
            }),
            perAttemptTimeoutMs,
            `${modelName}-no-thinking-cfg`
          );
          if (retryRes && retryRes.text) {
            return { text: retryRes.text, modelUsed: modelName };
          }
        } catch (retryErr) {
          lastError = retryErr;
        }
      }
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

async function advanceJobOneStep(job: DiagnosticJob) {
  if (job.status !== 'running' || job.isProcessingStep) return;
  job.isProcessingStep = true;

  try {
    const ai = getGeminiClient();
    const attachments =
      (job.payload.attachments as Array<{
        id: string;
        name: string;
        mimeType: string;
        sizeBytes?: number;
        sequenceIndex?: number;
        categoryTag?: string;
        panelName?: string;
      }>) || [];

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
                ThinkingLevel.MINIMAL,
                true
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

            if (endRange < totalPages) {
              job.isProcessingStep = false;
              return;
            }
          }
        }
      }
    }

    const parts: unknown[] = [];
    const allSelectedPages: number[] = [];
    const queryText = String(job.payload.query || job.payload.message || '');
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
                ThinkingLevel.MINIMAL,
                true
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
        ThinkingLevel.MINIMAL,
        false
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
      const chatHistory = job.payload.chatHistory as Array<{
        role: string;
        content: string;
      }>;
      const formattedHistory = Array.isArray(chatHistory)
        ? chatHistory
            .map((m) => {
              const cleaned =
                m.role === 'assistant'
                  ? sanitizeChatHistoryItem(String(m.content || ''))
                  : String(m.content || '');
              if (!cleaned) return '';
              return `${m.role === 'user' ? 'OPERADOR' : 'ENGENHEIRO IA'}: ${cleaned}`;
            })
            .filter(Boolean)
            .join('\n\n')
        : '';

      parts.push({
        text: `CONTEXTO DO LAUDO ATUAL (Alarme: "${job.payload.alarmTitle || ''}"):\n${job.payload.diagnosticMarkdown || ''}\n\n${formattedHistory ? `HISTÓRICO DO CHAT:\n${formattedHistory}\n` : ''}`,
      });

      if (job.payload.inlineImageBase64 && job.payload.inlineImageMimeType) {
        parts.push({
          text: '🚨 [ATENÇÃO: FOTO DE CAMPO / MEDIÇÃO ANEXADA NESTA MENSAGEM PELO OPERADOR — EXAMINE A IMAGEM IMEDIATAMENTE ABAIXO!]:',
        });
        parts.push({
          inlineData: {
            mimeType: String(job.payload.inlineImageMimeType),
            data: String(job.payload.inlineImageBase64),
          },
        });
      }

      parts.push({
        text: `NOVA MENSAGEM DO OPERADOR:\n"${job.payload.message}"`,
      });

      const result = await callGeminiFast(
        ai,
        parts,
        CHAT_SYSTEM_INSTRUCTION,
        ThinkingLevel.MINIMAL,
        false
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

/**
 * Stateless Serverless Step Endpoint with Immediate Chunked Heartbeat
 * so Vercel Hobby NEVER times out with HTTP 504!
 */
app.post('/api/serverless-step', async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Transfer-Encoding', 'chunked');
  // Flush first whitespace byte immediately (<10ms TTFB) to prevent Vercel 504 timeout
  res.write(' ');

  const heartbeat = setInterval(() => {
    try {
      res.write(' ');
    } catch {
      // Ignore if socket closed
    }
  }, 1500);

  const sendChunkedJson = (payload: Record<string, unknown>) => {
    clearInterval(heartbeat);
    res.end(JSON.stringify(payload));
  };

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
        ThinkingLevel.MINIMAL,
        true
      );
      return sendChunkedJson({ summary: result.text });
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
        ThinkingLevel.MINIMAL,
        true
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
      return sendChunkedJson({ selectedPages });
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

      let result: { text: string; modelUsed: string };
      try {
        result = await withTimeout(
          callGeminiFast(
            ai,
            parts,
            SYSTEM_INSTRUCTION,
            ThinkingLevel.MINIMAL,
            false
          ),
          36000,
          'diagnose-multimodal'
        );
      } catch {
        // Fallback ultra-rápido usando o índice textual completo já extraído caso o binário PDF seja muito pesado
        const textOnlyParts = parts.filter(
          (p) =>
            p &&
            typeof p === 'object' &&
            !('inlineData' in (p as Record<string, unknown>))
        );
        result = await callGeminiFast(
          ai,
          textOnlyParts,
          SYSTEM_INSTRUCTION,
          ThinkingLevel.MINIMAL,
          true
        );
      }

      const markdownText = result.text || '';
      const lower = markdownText.toLowerCase();
      return sendChunkedJson({
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
        latestAttachmentParts,
        chatAttachmentName,
        chatAttachmentMimeType,
        chatAttachmentPanel,
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
      const formattedChat = Array.isArray(chatHistory)
        ? chatHistory
            .map((m: { role: string; content: string }) => {
              const cleaned =
                m.role === 'assistant'
                  ? sanitizeChatHistoryItem(String(m.content || ''))
                  : String(m.content || '');
              if (!cleaned) return '';
              return `${m.role === 'user' ? 'OPERADOR EM CAMPO' : 'ENGENHEIRO ESPECIALISTA (IA)'}: ${cleaned}`;
            })
            .filter(Boolean)
            .join('\n\n')
        : '';

      parts.push({
        text: `CONTEXTO DO LAUDO TÉCNICO ATUAL (Alarme: "${alarmTitle || 'Em investigação'}"):\n${diagnosticMarkdown || 'Sem laudo inicial.'}\n\n${formattedChat ? `HISTÓRICO DA CONVERSA NO CHAT:\n${formattedChat}\n` : ''}`,
      });

      if (
        Array.isArray(latestAttachmentParts) &&
        latestAttachmentParts.length > 0
      ) {
        parts.push({
          text: `🚨 [ATENÇÃO: O OPERADOR ACABOU DE ANEXAR UM NOVO ARQUIVO PDF NESTA MENSAGEM DO CHAT: "${chatAttachmentName || 'Novo Desenho.pdf'}"${chatAttachmentPanel ? ` (Painel: ${chatAttachmentPanel})` : ''}. O ÍNDICE COMPLETO E AS PÁGINAS EM ALTA RESOLUÇÃO DESTE NOVO ARQUIVO ESTÃO IMEDIATAMENTE ABAIXO — ANALISE-OS AGORA!]:`,
        });
        parts.push(...latestAttachmentParts);
      }

      if (inlineImageBase64 && inlineImageMimeType) {
        parts.push({
          text: `🚨 [ATENÇÃO: O OPERADOR ACABOU DE ANEXAR UMA FOTO DE CAMPO / IMAGEM NESTA MENSAGEM DO CHAT ("${chatAttachmentName || 'foto_campo.jpg'}"). A IMAGEM ESTÁ IMEDIATAMENTE ABAIXO — EXAMINE VISUALMENTE TODOS OS DETALHES DA FOTO (DISJUNTOR, MULTÍMETRO, BORNES, FIOS, TAGS) E RESPONDA DIRETAMENTE SOBRE ELA!]:`,
        });
        parts.push({
          inlineData: {
            mimeType: inlineImageMimeType,
            data: inlineImageBase64,
          },
        });
      }

      parts.push({
        text: `NOVA MENSAGEM DO OPERADOR EM CAMPO${chatAttachmentName ? ` (enviada junto com o arquivo anexado "${chatAttachmentName}" [${chatAttachmentMimeType || 'anexo'}])` : ''}:\n"${message}"\n\nResponda em Markdown técnico claro, objetivo e direto, analisando integralmente o arquivo/foto anexado (se presente) para auxiliar o operador em campo.`,
      });

      let result: { text: string; modelUsed: string };
      try {
        result = await withTimeout(
          callGeminiFast(
            ai,
            parts,
            CHAT_SYSTEM_INSTRUCTION,
            ThinkingLevel.MINIMAL,
            false
          ),
          36000,
          'chat-multimodal'
        );
      } catch {
        const textOnlyParts = parts.filter(
          (p) =>
            p &&
            typeof p === 'object' &&
            !('inlineData' in (p as Record<string, unknown>))
        );
        result = await callGeminiFast(
          ai,
          textOnlyParts,
          CHAT_SYSTEM_INSTRUCTION,
          ThinkingLevel.MINIMAL,
          true
        );
      }

      return sendChunkedJson({
        status: 'completed',
        markdown: result.text || '',
        modelUsed: result.modelUsed,
        timestamp: new Date().toISOString(),
      });
    }

    return sendChunkedJson({ ok: false, error: 'Ação inválida.' });
  } catch (err) {
    return sendChunkedJson({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro interno.',
    });
  }
});

// History + Supabase Cloud Sync endpoints
app.get('/api/supabase/status', async (_req, res) => {
  const cfg = getSupabaseConfig();
  if (!cfg) {
    return res.json({
      configured: false,
      connected: false,
      tableReady: false,
      projectName: SUPABASE_PROJECT_LABEL,
      tableName: SUPABASE_TABLE,
      message:
        'Variáveis SUPABASE_URL e SUPABASE_ANON_KEY ainda não configuradas no ambiente.',
    });
  }

  const supRes = await fetchHistoryFromSupabase();
  if (!supRes.ok) {
    const isMissingTable =
      supRes.error?.includes('42P01') ||
      supRes.error?.includes('PGRST205') ||
      supRes.error?.toLowerCase().includes('does not exist') ||
      supRes.error?.toLowerCase().includes('could not find the table');

    return res.json({
      configured: true,
      connected: false,
      tableReady: !isMissingTable,
      projectName: SUPABASE_PROJECT_LABEL,
      tableName: SUPABASE_TABLE,
      message: isMissingTable
        ? `Conectado ao projeto "${SUPABASE_PROJECT_LABEL}", mas falta executar o script SQL para criar a tabela "${SUPABASE_TABLE}".`
        : `Erro ao consultar Supabase (${SUPABASE_PROJECT_LABEL}): ${supRes.error}`,
    });
  }

  return res.json({
    configured: true,
    connected: true,
    tableReady: true,
    projectName: SUPABASE_PROJECT_LABEL,
    tableName: SUPABASE_TABLE,
    count: supRes.items.length,
    message: `Sincronizado em tempo real com Supabase (${SUPABASE_PROJECT_LABEL} • tabela ${SUPABASE_TABLE}).`,
  });
});

app.get('/api/history', async (_req, res) => {
  const localItems = readHistoryDb() as Array<Record<string, unknown>>;
  let items: Array<Record<string, unknown>> = localItems;
  let storageMode: 'supabase' | 'local' = 'local';

  const supRes = await fetchHistoryFromSupabase();
  if (supRes.ok) {
    storageMode = 'supabase';
    const supIds = new Set(supRes.items.map((i) => String(i.id)));
    const unsyncedLocal = localItems.filter(
      (l) => l.id && !supIds.has(String(l.id))
    );

    if (unsyncedLocal.length > 0) {
      await upsertHistoryToSupabase(unsyncedLocal);
      items = [...unsyncedLocal, ...supRes.items].slice(0, 100);
    } else {
      items = supRes.items;
    }
    writeHistoryDb(items);
  }

  return res.json({
    items,
    storageMode,
    supabaseProject: SUPABASE_PROJECT_LABEL,
    supabaseTable: SUPABASE_TABLE,
  });
});

app.post('/api/history', async (req, res) => {
  const record = req.body;
  if (!record || !record.id) return res.status(400).json({ error: 'Inválido' });
  const nowIso = new Date().toISOString();
  const normalizedRecord: Record<string, unknown> = {
    status: 'em_investigacao',
    isFavorite: false,
    ...record,
    updatedAt: nowIso,
  };

  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const idx = items.findIndex((i) => i.id === record.id);
  if (idx >= 0) {
    items[idx] = {
      ...items[idx],
      ...normalizedRecord,
    };
  } else {
    items.unshift(normalizedRecord);
  }
  const trimmed = items.slice(0, 100);
  writeHistoryDb(trimmed);

  const synced = await upsertHistoryToSupabase([
    idx >= 0 ? items[idx] : normalizedRecord,
  ]);
  return res.json({
    status: 'saved',
    storageMode: synced ? 'supabase' : 'local',
    items: trimmed,
  });
});

app.post('/api/history/sync', async (req, res) => {
  try {
    const clientItems = Array.isArray(req.body?.items)
      ? (req.body.items as Array<Record<string, unknown>>)
      : [];
    const localItems = readHistoryDb() as Array<Record<string, unknown>>;

    const mergedMap = new Map<string, Record<string, unknown>>();
    for (const item of [...localItems, ...clientItems]) {
      if (item && item.id) {
        mergedMap.set(String(item.id), item);
      }
    }

    const supRes = await fetchHistoryFromSupabase();
    if (supRes.ok) {
      for (const supItem of supRes.items) {
        if (supItem && supItem.id) {
          const idStr = String(supItem.id);
          const existing = mergedMap.get(idStr);
          if (!existing) {
            mergedMap.set(idStr, supItem);
          } else {
            const supTime = new Date(String(supItem.updatedAt || 0)).getTime();
            const locTime = new Date(String(existing.updatedAt || 0)).getTime();
            if (supTime >= locTime) {
              mergedMap.set(idStr, supItem);
            }
          }
        }
      }
    }

    const mergedList = Array.from(mergedMap.values())
      .sort(
        (a, b) =>
          new Date(String(b.updatedAt || 0)).getTime() -
          new Date(String(a.updatedAt || 0)).getTime()
      )
      .slice(0, 100);

    writeHistoryDb(mergedList);
    const synced = await upsertHistoryToSupabase(mergedList);

    return res.json({
      status: 'synced',
      storageMode: synced || supRes.ok ? 'supabase' : 'local',
      supabaseProject: SUPABASE_PROJECT_LABEL,
      items: mergedList,
    });
  } catch (err) {
    return res.status(500).json({
      error:
        err instanceof Error ? err.message : 'Erro ao sincronizar histórico.',
    });
  }
});

app.patch('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const idx = items.findIndex((i) => i.id === id);

  let updatedRecord: Record<string, unknown> | null = null;
  if (idx !== -1) {
    items[idx] = {
      ...items[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    updatedRecord = items[idx];
    writeHistoryDb(items);
  } else {
    const supRes = await fetchHistoryFromSupabase();
    const foundInSup = supRes.items.find((i) => String(i.id) === id);
    if (foundInSup) {
      const nextRec: Record<string, unknown> = {
        ...foundInSup,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      updatedRecord = nextRec;
      items.unshift(nextRec);
      writeHistoryDb(items.slice(0, 100));
    }
  }

  if (!updatedRecord) {
    return res.status(404).json({ error: 'Não encontrado' });
  }

  const synced = await upsertHistoryToSupabase([updatedRecord]);
  return res.json({
    status: 'updated',
    storageMode: synced ? 'supabase' : 'local',
    item: updatedRecord,
    items,
  });
});

app.delete('/api/history/:id', async (req, res) => {
  const items = readHistoryDb() as Array<Record<string, unknown>>;
  const next = items.filter((i) => i.id !== req.params.id);
  writeHistoryDb(next);
  const deletedFromSupabase = await deleteHistoryFromSupabase(req.params.id);
  return res.json({
    status: 'deleted',
    storageMode: deletedFromSupabase ? 'supabase' : 'local',
    items: next,
  });
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

// Diagnose Job Creation
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

// Poll Status Endpoint
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

const BACKUP_FILE_LIST = [
  'package.json',
  'vercel.json',
  'api/index.ts',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'metadata.json',
  '.env.example',
  '.gitignore',
  'supabase_hydrodiag_schema.sql',
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
  'src/components/PdfDeepLinkDrawer.tsx',
  'src/components/GitHubDeployModal.tsx',
];

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf-8');
    const uncompressed = entry.data;
    const compressed = zlib.deflateRawSync(uncompressed);
    const fileCrc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function collectBackupFiles(): Array<{
  path: string;
  sizeBytes: number;
  content: string;
  buffer: Buffer;
}> {
  const rootDir = process.cwd();
  const collected: Array<{
    path: string;
    sizeBytes: number;
    content: string;
    buffer: Buffer;
  }> = [];

  for (const relPath of BACKUP_FILE_LIST) {
    const absPath = path.join(rootDir, relPath);
    if (fs.existsSync(absPath)) {
      const rawBuf = fs.readFileSync(absPath);
      collected.push({
        path: relPath,
        sizeBytes: rawBuf.length,
        content: rawBuf.toString('utf-8'),
        buffer: rawBuf,
      });
    }
  }
  return collected;
}

app.get('/api/backup/source-bundle', (_req, res) => {
  try {
    const files = collectBackupFiles();
    const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
    return res.json({
      generatedAt: new Date().toISOString(),
      projectName: 'hydrodiag-ai-pch-uhe',
      totalFiles: files.length,
      totalBytes,
      files: files.map((f) => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
        content: f.content,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      error:
        err instanceof Error ? err.message : 'Erro ao gerar backup do código.',
    });
  }
});

app.get('/api/backup/download-zip', (_req, res) => {
  try {
    const files = collectBackupFiles();
    const zipBuffer = buildZipBuffer(
      files.map((f) => ({ name: f.path, data: f.buffer }))
    );
    const dateTag = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="hydrodiag-ai-codigo-completo-backup-${dateTag}.zip"`
    );
    res.setHeader('Content-Length', String(zipBuffer.length));
    return res.send(zipBuffer);
  } catch (err) {
    return res.status(500).json({
      error:
        err instanceof Error ? err.message : 'Erro ao baixar arquivo ZIP.',
    });
  }
});

export default app;
