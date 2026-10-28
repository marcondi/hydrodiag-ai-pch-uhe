import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
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
Caso haja novas dúvidas ou falhas, forneça o próximo diagrama detalhado.
IMPORTANTE SOBRE SÍMBOLOS ELÉTRICOS: Use SEMPRE símbolos Unicode diretos (Ω, kΩ, MΩ, μF, μA, ±, ≈, ×, Δ, φ, °C, ∞) e escreva por extenso "menor que" e "maior que" em vez de usar os símbolos < e > (ex: "menor que 2 Ω", "maior que 1 kΩ"). NUNCA use código LaTeX com cifrões como $\\Omega$ ou $\\text{k}\\Omega$.`;

export const CHAT_SYSTEM_INSTRUCTION = `Você é um Engenheiro Eletricista Sênior Especialista em Instalações Hidrelétricas (PCH e UHE), Proteção de Sistemas de Potência, Comissionamento e Automação Industrial (padrões WEG, IEC, ANSI/IEEE e NR-10).
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
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?select=*&status=neq.pdf_vault_chunk&order=updated_at.desc&limit=100`,
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
      ? rows
          .filter(
            (r) =>
              String(r.status || '') !== 'pdf_vault_chunk' &&
              !String(r.id || '').startsWith('__pdf_blob__')
          )
          .map(supabaseRowToInvestigation)
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

const CHUNK_DOWNLOAD_SIZE = 1500 * 1024;

function getCanonicalPdfNameSlug(name?: string): string {
  return (name || 'diagrama.pdf')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 60);
}

async function savePdfChunkToSupabase(params: {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  chunkIndex: number;
  totalChunks: number;
  chunkData: string;
}): Promise<boolean> {
  const cfg = getSupabaseConfig();
  if (!cfg || !params.chunkData) return false;
  const slug = getCanonicalPdfNameSlug(params.name);
  const rowId = `__pdf_blob__${slug}__c_${params.chunkIndex}`;
  const nowIso = new Date().toISOString();
  const row = {
    id: rowId,
    title: `[PDF_VAULT] ${params.name || 'diagrama.pdf'} (${params.chunkIndex + 1}/${params.totalChunks})`,
    status: 'pdf_vault_chunk',
    is_favorite: false,
    field_resolution_note: slug,
    created_at: nowIso,
    updated_at: nowIso,
    attachment_metadata: [
      {
        id: params.attachmentId,
        name: params.name,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes || 0,
        chunkIndex: params.chunkIndex,
        totalChunks: params.totalChunks,
        slug,
      },
    ],
    turns: [],
    raw_payload: {
      chunkIndex: params.chunkIndex,
      totalChunks: params.totalChunks,
      chunkData: params.chunkData,
      name: params.name,
      sizeBytes: params.sizeBytes || 0,
      mimeType: params.mimeType,
      slug,
    },
  };

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?on_conflict=id`,
      {
        method: 'POST',
        headers: getSupabaseHeaders(cfg.key, {
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify([row]),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchPdfChunkFromSupabase(params: {
  name?: string;
  chunkIndex: number;
}): Promise<{ chunkData: string; totalChunks: number } | null> {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;

  const extractFromRows = (
    rows: unknown
  ): { chunkData: string; totalChunks: number } | null => {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    const raw =
      r.raw_payload && typeof r.raw_payload === 'object'
        ? (r.raw_payload as Record<string, unknown>)
        : {};
    const chunkData = typeof raw.chunkData === 'string' ? raw.chunkData : '';
    const totalChunks =
      typeof raw.totalChunks === 'number' && raw.totalChunks > 0
        ? raw.totalChunks
        : 1;
    if (chunkData.length > 0) {
      return { chunkData, totalChunks };
    }
    return null;
  };

  try {
    if (params.name) {
      const slug = getCanonicalPdfNameSlug(params.name);
      const exactId = `__pdf_blob__${slug}__c_${params.chunkIndex}`;
      const res = await fetch(
        `${cfg.url}/rest/v1/${SUPABASE_TABLE}?select=raw_payload&id=eq.${encodeURIComponent(exactId)}&limit=1`,
        {
          method: 'GET',
          headers: getSupabaseHeaders(cfg.key),
        }
      );
      if (res.ok) {
        const found = extractFromRows(await res.json());
        if (found) return found;
      }
    }

    // Fallback: latest PDF chunk with this chunkIndex in Supabase Vault
    const fallbackRes = await fetch(
      `${cfg.url}/rest/v1/${SUPABASE_TABLE}?select=raw_payload&status=eq.pdf_vault_chunk&id=like.*__c_${params.chunkIndex}&order=updated_at.desc&limit=1`,
      {
        method: 'GET',
        headers: getSupabaseHeaders(cfg.key),
      }
    );
    if (fallbackRes.ok) {
      return extractFromRows(await fallbackRes.json());
    }
  } catch {
    // Ignore Supabase network error
  }
  return null;
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
      const config: Record<string, unknown> = {
        temperature: 0.2,
      };
      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }
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
        return {
          text: response.text,
          modelUsed: modelName,
        };
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[HydroDiag AI] Modelo ${modelName} retornou: ${msg.slice(0, 140)}`
      );
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
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(' ');

    const heartbeat = setInterval(() => {
      try {
        res.write(' ');
      } catch {
        // Ignore
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
          ThinkingLevel.MINIMAL,
          true
        );
        return sendChunkedJson({ summary: result.text });
      }

      if (action === 'transcribe_audio') {
        const { audioBase64, mimeType } = req.body;
        if (!audioBase64 || String(audioBase64).length < 100) {
          return sendChunkedJson({ transcript: '' });
        }
        const rawMime = String(mimeType || 'audio/webm')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const cleanMime =
          rawMime === 'audio/mp4' ||
          rawMime === 'audio/ogg' ||
          rawMime === 'audio/wav' ||
          rawMime === 'audio/mpeg' ||
          rawMime === 'audio/webm'
            ? rawMime
            : 'audio/webm';

        const result = await callGeminiFast(
          ai,
          [
            {
              inlineData: {
                mimeType: cleanMime,
                data: String(audioBase64),
              },
            },
            {
              text: 'Transcreva fielmente em português do Brasil tudo o que foi falado neste áudio pelo operador/engenheiro de manutenção de usina hidrelétrica (PCH/UHE). Preserve termos técnicos como 125 Vcc, 24 Vcc, 220 Vca, bornes X2, 1X2, 2X2, XED, UHLM, PCPG1, PCPG2, CLP-SASE, QDCC, disjuntor 52G, chave 89. Se o áudio contiver apenas silêncio ou ruído sem fala humana, retorne exatamente vazio "". Caso contrário, retorne APENAS as palavras faladas, sem aspas e sem comentários adicionais.',
            },
          ],
          null,
          ThinkingLevel.MINIMAL,
          true
        );
        const cleaned = (result.text || '')
          .trim()
          .replace(/^["']+|["']+$/g, '')
          .trim();
        return sendChunkedJson({ transcript: cleaned });
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

        return sendChunkedJson({
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

        const formattedChatHistory = Array.isArray(chatHistory)
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
          text: `CONTEXTO DO LAUDO TÉCNICO ATUAL (Alarme: "${alarmTitle || 'Em investigação'}"):
${diagnosticMarkdown || 'Sem laudo inicial.'}

${formattedChatHistory ? `HISTÓRICO DA CONVERSA NO CHAT:\n${formattedChatHistory}\n` : ''}`,
        });

        // Inject newly attached PDF or field photo RIGHT NEXT to the operator's new message so Gemini unmistakably sees it
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
          text: `NOVA MENSAGEM DO OPERADOR EM CAMPO${chatAttachmentName ? ` (enviada junto com o arquivo anexado "${chatAttachmentName}" [${chatAttachmentMimeType || 'anexo'}])` : ''}:
"${message}"

Responda em Markdown técnico claro, objetivo e direto, analisando integralmente o arquivo/foto anexado (se presente) para auxiliar o operador em campo.`,
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
          markdown:
            result.text || 'Não foi possível processar a resposta do chat.',
          modelUsed: result.modelUsed,
          timestamp: new Date().toISOString(),
        });
      }

      return sendChunkedJson({
        ok: false,
        error: 'Ação serverless desconhecida.',
      });
    } catch (err) {
      console.error('Erro em /api/serverless-step:', err);
      return sendChunkedJson({
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao processar requisição na função serverless.',
      });
    }
  });

  // ============================================================================
  // 1. PERSISTENT FAULT HISTORY DATABASE API (/api/history + Supabase Cloud Sync)
  // ============================================================================
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

  app.get('/api/history', async (req, res) => {
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

    return res.json({
      items: filtered,
      storageMode,
      supabaseProject: SUPABASE_PROJECT_LABEL,
      supabaseTable: SUPABASE_TABLE,
    });
  });

  app.post('/api/history', async (req, res) => {
    try {
      const record = req.body;
      if (!record || !record.id) {
        return res.status(400).json({ error: 'Registro inválido.' });
      }
      const nowIso = new Date().toISOString();
      const normalizedRecord: Record<string, unknown> = {
        status: 'em_investigacao',
        isFavorite: false,
        ...record,
        updatedAt: nowIso,
      };

      const items = readHistoryDb() as Array<Record<string, unknown>>;
      const existingIndex = items.findIndex((i) => i.id === record.id);
      if (existingIndex >= 0) {
        items[existingIndex] = {
          ...items[existingIndex],
          ...normalizedRecord,
        };
      } else {
        items.unshift(normalizedRecord);
      }
      const trimmed = items.slice(0, 100);
      writeHistoryDb(trimmed);

      const syncedToSupabase = await upsertHistoryToSupabase([
        existingIndex >= 0 ? items[existingIndex] : normalizedRecord,
      ]);

      return res.json({
        status: 'saved',
        storageMode: syncedToSupabase ? 'supabase' : 'local',
        items: trimmed,
      });
    } catch (err) {
      console.error('Erro ao salvar histórico:', err);
      return res.status(500).json({ error: 'Erro ao salvar histórico.' });
    }
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
              const locTime = new Date(
                String(existing.updatedAt || 0)
              ).getTime();
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
          err instanceof Error
            ? err.message
            : 'Erro ao sincronizar histórico.',
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
      return res.status(404).json({ error: 'Registro não encontrado.' });
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
    const { id } = req.params;
    const items = readHistoryDb() as Array<Record<string, unknown>>;
    const next = items.filter((i) => i.id !== id);
    writeHistoryDb(next);
    const deletedFromSupabase = await deleteHistoryFromSupabase(id);
    return res.json({
      status: 'deleted',
      storageMode: deletedFromSupabase ? 'supabase' : 'local',
      items: next,
    });
  });

  // ============================================================================
  // 2. CHUNKED PDF / PHOTO UPLOAD API (/api/upload-chunk)
  // ============================================================================
  app.get('/api/attachments/fetch-binary', async (req, res) => {
    try {
      const id = String(req.query.id || '');
      const name = String(req.query.name || '');
      const sizeBytes = Number(req.query.sizeBytes || 0);
      const chunkIndexParam = req.query.chunkIndex;
      const chunkIndex =
        chunkIndexParam !== undefined ? Number(chunkIndexParam) : 0;

      const stored = findStoredAttachment({
        id,
        name: name || undefined,
        sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
      });
      if (stored) {
        let fullB64 = stored.completeBase64 || '';
        if (!fullB64 && stored.filePath && fs.existsSync(stored.filePath)) {
          fullB64 = fs.readFileSync(stored.filePath).toString('base64');
        }
        if (fullB64) {
          const totalChunks = Math.max(
            1,
            Math.ceil(fullB64.length / CHUNK_DOWNLOAD_SIZE)
          );
          const start = chunkIndex * CHUNK_DOWNLOAD_SIZE;
          const chunkData = fullB64.slice(start, start + CHUNK_DOWNLOAD_SIZE);
          return res.json({
            ok: true,
            chunkData,
            chunkIndex,
            totalChunks,
          });
        }
      }

      const cloudChunk = await fetchPdfChunkFromSupabase({
        name: name || undefined,
        chunkIndex: isNaN(chunkIndex) ? 0 : chunkIndex,
      });
      if (cloudChunk) {
        return res.json({
          ok: true,
          chunkData: cloudChunk.chunkData,
          chunkIndex: isNaN(chunkIndex) ? 0 : chunkIndex,
          totalChunks: cloudChunk.totalChunks,
        });
      }

      return res.status(404).json({ ok: false });
    } catch {
      return res.status(404).json({ ok: false });
    }
  });

  app.post('/api/upload-chunk', async (req, res) => {
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

      await savePdfChunkToSupabase({
        attachmentId: String(attachmentId || ''),
        name: String(name || 'diagrama.pdf'),
        mimeType: String(mimeType || 'application/pdf'),
        sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
        chunkIndex: Number(chunkIndex || 0),
        totalChunks: Number(totalChunks || 1),
        chunkData: String(chunkData || ''),
      });

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

          const formattedChatHistory = Array.isArray(chatHistory)
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
            text: `CONTEXTO DO LAUDO TÉCNICO ATUAL (Alarme: "${alarmTitle || 'Em investigação'}"):
${diagnosticMarkdown || 'Sem laudo inicial.'}

${formattedChatHistory ? `HISTÓRICO DA CONVERSA NO CHAT:\n${formattedChatHistory}\n` : ''}`,
          });

          if (inlineImageBase64 && inlineImageMimeType) {
            parts.push({
              text: '🚨 [ATENÇÃO: FOTO DE CAMPO / MEDIÇÃO ANEXADA NESTA MENSAGEM PELO OPERADOR — EXAMINE A IMAGEM IMEDIATAMENTE ABAIXO!]:',
            });
            parts.push({
              inlineData: {
                mimeType: inlineImageMimeType,
                data: inlineImageBase64,
              },
            });
          }

          parts.push({
            text: `NOVA MENSAGEM DO OPERADOR EM CAMPO:
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

      const baseFilesToPublish = [
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
        'public/icon.svg',
        'server.ts',
        'src/main.tsx',
        'src/index.css',
        'src/types.ts',
        'src/App.tsx',
        'src/hooks/usePWAInstall.ts',
        'src/utils/pdfClientEngine.ts',
        'src/utils/speechSynthesisEngine.ts',
        'src/utils/voiceDictationEngine.ts',
        'src/components/DiagramUploadPanel.tsx',
        'src/components/FaultQueryPanel.tsx',
        'src/components/DiagnosticReportView.tsx',
        'src/components/FaultChatPanel.tsx',
        'src/components/PdfDeepLinkDrawer.tsx',
        'src/components/FieldCameraModal.tsx',
        'src/components/MobileQrHandoffModal.tsx',
        'src/components/GitHubDeployModal.tsx',
      ];

      const discoverSrcFiles = (dirRel: string): string[] => {
        const found: string[] = [];
        const absDir = path.join(__dirname, dirRel);
        if (!fs.existsSync(absDir)) return found;
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          const rel = path.posix.join(dirRel.replace(/\\/g, '/'), entry.name);
          if (entry.isDirectory()) {
            found.push(...discoverSrcFiles(rel));
          } else if (/\.(ts|tsx|css|json)$/i.test(entry.name)) {
            found.push(rel);
          }
        }
        return found;
      };

      const filesToPublish = Array.from(
        new Set([...baseFilesToPublish, ...discoverSrcFiles('src')])
      );

      const readmeContent = `# ⚡ HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas (PCH / UHE)

Sistema especialista multimodal desenvolvido para engenharia de manutenção, proteção e automação de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 🚀 Funcionalidades Principais
- **Leitura Multimodal de Cadernos Elétricos (100+ páginas):** Indexação automática e recorte cirúrgico de diagramas funcionais (\`/EL\`), réguas de bornes (\`/RB\`), layout mecânico (\`/ME\`) e relação de materiais (\`/RM\`) no padrão WEG / IEC / ANSI.
- **Guia Prático de Ponta de Prova (Multímetro):** Indicação exata de réguas de bornes (\`1X2\`, \`2X2\`, \`3XD\`, \`XED\`), terminais (\`13-14\`, \`21-22\`) e tensões esperadas (\`125 Vcc\`, \`24 Vcc\`, \`220 Vca\`).
- **Inspetor Deep-Link de Folhas do PDF:** Clique em qualquer número de página ou folha no laudo/chat para abrir instantaneamente a página recortada em alta resolução.
- **Banco de Dados em Nuvem Supabase (Projeto: Agenda Financeira youware):** Sincronização em tempo real dos diagnósticos entre múltiplos computadores usando a tabela isolada \`hydrodiag_investigations\`.

## ☁️ Como Publicar na Vercel + Conectar ao Supabase (Acesso em Qualquer PC)
1. No painel do **Supabase**, abra o projeto **\`Agenda Financeira youware\`**, clique em **SQL Editor** e execute o arquivo \`supabase_hydrodiag_schema.sql\`.
2. Acesse [https://vercel.com/new](https://vercel.com/new) e importe este repositório (\`hydrodiag-ai-pch-uhe\`).
3. Em **Environment Variables** da Vercel, adicione:
   - \`GEMINI_API_KEY\`: Sua chave da API do Google Gemini
   - \`SUPABASE_URL\`: \`https://oooegbbvrwifilavlvgt.supabase.co\`
   - \`SUPABASE_ANON_KEY\`: A chave \`anon public\` do seu projeto \`Agenda Financeira youware\`
4. Clique em **Deploy**. O arquivo \`vercel.json\` e a função serverless \`api/index.ts\` já configuram automaticamente o backend e o frontend!
`;

      const uploadedFiles: string[] = ['README.md'];
      const treeItems: Array<{
        path: string;
        mode: '100644';
        type: 'blob';
        content: string;
      }> = [
        {
          path: 'README.md',
          mode: '100644',
          type: 'blob',
          content: readmeContent,
        },
      ];

      for (const relPath of filesToPublish) {
        const absPath = path.join(__dirname, relPath);
        if (fs.existsSync(absPath)) {
          const contentUtf8 = fs.readFileSync(absPath, 'utf-8');
          treeItems.push({
            path: relPath,
            mode: '100644',
            type: 'blob',
            content: contentUtf8,
          });
          uploadedFiles.push(relPath);
        }
      }

      // Atomic Single-Commit Push via GitHub Git Data API (prevents partial Vercel builds!)
      let atomicSuccess = false;
      try {
        const repoInfoRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepo}`,
          { headers }
        );
        const repoInfo = repoInfoRes.ok
          ? ((await repoInfoRes.json()) as { default_branch?: string })
          : {};
        const branch = repoInfo.default_branch || 'main';

        const refRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepo}/git/ref/heads/${branch}`,
          { headers }
        );

        if (refRes.ok) {
          const refData = (await refRes.json()) as {
            object?: { sha?: string };
          };
          const latestCommitSha = refData.object?.sha;

          if (latestCommitSha) {
            const commitRes = await fetch(
              `https://api.github.com/repos/${owner}/${cleanRepo}/git/commits/${latestCommitSha}`,
              { headers }
            );
            const commitData = commitRes.ok
              ? ((await commitRes.json()) as { tree?: { sha?: string } })
              : {};
            const baseTreeSha = commitData.tree?.sha;

            const createTreeRes = await fetch(
              `https://api.github.com/repos/${owner}/${cleanRepo}/git/trees`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
                  tree: treeItems,
                }),
              }
            );

            if (createTreeRes.ok) {
              const treeData = (await createTreeRes.json()) as { sha?: string };
              const newTreeSha = treeData.sha;

              // If the tree SHA is identical to baseTreeSha, skip creating a duplicate commit/deploy on Vercel
              if (newTreeSha && baseTreeSha && newTreeSha === baseTreeSha) {
                atomicSuccess = true;
              } else if (newTreeSha) {
                const stamp = new Date().toLocaleString('pt-BR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                });
                const newCommitRes = await fetch(
                  `https://api.github.com/repos/${owner}/${cleanRepo}/git/commits`,
                  {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                      message: `feat(release): HydroDiag AI — Camera de Campo + CAD Pan/Zoom + PDF Deep-Link (${stamp})`,
                      tree: newTreeSha,
                      parents: [latestCommitSha],
                    }),
                  }
                );

                if (newCommitRes.ok) {
                  const newCommitData = (await newCommitRes.json()) as {
                    sha?: string;
                  };
                  if (newCommitData.sha) {
                    const updateRefRes = await fetch(
                      `https://api.github.com/repos/${owner}/${cleanRepo}/git/refs/heads/${branch}`,
                      {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({
                          sha: newCommitData.sha,
                          force: true,
                        }),
                      }
                    );
                    if (updateRefRes.ok) {
                      atomicSuccess = true;
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // Fallback to sequential PUT if Git Data API is unavailable
      }

      if (!atomicSuccess) {
        const pushSingleFile = async (
          relPath: string,
          contentBase64: string
        ) => {
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

          if (existingSha && existingSha === localBlobSha) {
            return;
          }

          await fetch(
            `https://api.github.com/repos/${owner}/${cleanRepo}/contents/${relPath}`,
            {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                message: `feat: update ${relPath}`,
                content: contentBase64,
                ...(existingSha ? { sha: existingSha } : {}),
              }),
            }
          );
        };

        for (const item of treeItems) {
          await pushSingleFile(
            item.path,
            Buffer.from(item.content, 'utf-8').toString('base64')
          );
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

  app.get(['/sw.js', '/dev-sw.js', '/registerSW.js'], (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    if (req.path === '/registerSW.js') {
      return res.send('// No-op registerSW');
    }
    const targetFile = req.path === '/dev-sw.js' ? 'dev-sw.js' : 'sw.js';
    const swPath = path.join(__dirname, 'public', targetFile);
    if (fs.existsSync(swPath)) {
      return res.sendFile(swPath);
    }
    return res.send(
      "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.includes('pdf_binary_cache')).map((k) => caches.delete(k)))).then(() => self.clients.claim())));"
    );
  });

  // ============================================================================
  // 7. COMPLETE SOURCE CODE BACKUP & ZIP DOWNLOAD (/api/backup/*)
  // ============================================================================
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
    'public/icon.svg',
    'public/sw.js',
    'public/dev-sw.js',
    'server.ts',
    'src/main.tsx',
    'src/index.css',
    'src/types.ts',
    'src/App.tsx',
    'src/hooks/usePWAInstall.ts',
    'src/utils/pdfClientEngine.ts',
    'src/utils/speechSynthesisEngine.ts',
    'src/utils/voiceDictationEngine.ts',
    'src/components/DiagramUploadPanel.tsx',
    'src/components/FaultQueryPanel.tsx',
    'src/components/DiagnosticReportView.tsx',
    'src/components/FaultChatPanel.tsx',
    'src/components/PdfDeepLinkDrawer.tsx',
    'src/components/FieldCameraModal.tsx',
    'src/components/MobileQrHandoffModal.tsx',
    'src/components/GitHubDeployModal.tsx',
  ];

  const BACKUP_README_CONTENT = `# ⚡ HydroDiag AI — Backup Completo do Código-Fonte (PCH / UHE)

Sistema especialista multimodal para Engenharia Elétrica de Manutenção, Proteção, Automação e Supervisão de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 📦 Como Restaurar e Rodar Este Backup no Seu Computador
1. Extraia todos os arquivos deste pacote mantendo a estrutura de pastas (\`src/\`, \`src/components/\`, \`src/utils/\`, \`api/\`).
2. Crie um arquivo \`.env\` na raiz (ou copie o \`.env.example\`) e adicione sua chave da API Gemini:
   \`\`\`env
   GEMINI_API_KEY=sua_chave_aqui
   \`\`\`
3. Instale as dependências no terminal:
   \`\`\`bash
   npm install
   \`\`\`
4. Inicie o servidor completo (Frontend + Backend Express na porta 3000):
   \`\`\`bash
   npm run dev
   \`\`\`

## ☁️ Como Publicar na Vercel
- Este backup já inclui \`vercel.json\` e \`api/index.ts\`.
- Basta importar a pasta/repositório na Vercel e configurar a variável de ambiente \`GEMINI_API_KEY\`.
`;

  // Precomputed CRC32 table for standard PKZIP archive generation
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

  function buildZipBuffer(
    entries: Array<{ name: string; data: Buffer }>
  ): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf-8');
      const uncompressed = entry.data;
      const compressed = zlib.deflateRawSync(uncompressed);
      const fileCrc = crc32(uncompressed);

      // Local file header (30 bytes + filename)
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // signature
      localHeader.writeUInt16LE(20, 4); // version needed
      localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
      localHeader.writeUInt16LE(8, 8); // method: deflate
      localHeader.writeUInt16LE(0, 10); // mod time
      localHeader.writeUInt16LE(0x5421, 12); // mod date
      localHeader.writeUInt32LE(fileCrc, 14);
      localHeader.writeUInt32LE(compressed.length, 18);
      localHeader.writeUInt32LE(uncompressed.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28); // extra len

      localParts.push(localHeader, nameBuf, compressed);

      // Central directory header (46 bytes + filename)
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0); // signature
      centralHeader.writeUInt16LE(20, 4); // version made by
      centralHeader.writeUInt16LE(20, 6); // version needed
      centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
      centralHeader.writeUInt16LE(8, 10); // method: deflate
      centralHeader.writeUInt16LE(0, 12); // mod time
      centralHeader.writeUInt16LE(0x5421, 14); // mod date
      centralHeader.writeUInt32LE(fileCrc, 16);
      centralHeader.writeUInt32LE(compressed.length, 20);
      centralHeader.writeUInt32LE(uncompressed.length, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30); // extra len
      centralHeader.writeUInt16LE(0, 32); // comment len
      centralHeader.writeUInt16LE(0, 34); // disk number
      centralHeader.writeUInt16LE(0, 36); // internal attrs
      centralHeader.writeUInt32LE(0, 38); // external attrs
      centralHeader.writeUInt32LE(offset, 42); // local header offset

      centralParts.push(centralHeader, nameBuf);
      offset += localHeader.length + nameBuf.length + compressed.length;
    }

    const centralDirBuf = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // start disk
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20); // comment len

    return Buffer.concat([...localParts, centralDirBuf, eocd]);
  }

  function collectProjectBackupFiles(): Array<{
    path: string;
    sizeBytes: number;
    content: string;
    buffer: Buffer;
  }> {
    const collected: Array<{
      path: string;
      sizeBytes: number;
      content: string;
      buffer: Buffer;
    }> = [];

    const readmeBuf = Buffer.from(BACKUP_README_CONTENT, 'utf-8');
    collected.push({
      path: 'README.md',
      sizeBytes: readmeBuf.length,
      content: BACKUP_README_CONTENT,
      buffer: readmeBuf,
    });

    const scanDirRecursive = (dirRel: string): string[] => {
      const found: string[] = [];
      const absDir = path.join(__dirname, dirRel);
      if (!fs.existsSync(absDir)) return found;
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const rel = path.posix.join(dirRel.replace(/\\/g, '/'), entry.name);
        if (entry.isDirectory()) {
          found.push(...scanDirRecursive(rel));
        } else if (/\.(ts|tsx|css|json)$/i.test(entry.name)) {
          found.push(rel);
        }
      }
      return found;
    };

    const allPaths = Array.from(
      new Set([...BACKUP_FILE_LIST, ...scanDirRecursive('src')])
    );

    for (const relPath of allPaths) {
      const absPath = path.join(__dirname, relPath);
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

    if (fs.existsSync(HISTORY_DB_PATH)) {
      try {
        const histBuf = fs.readFileSync(HISTORY_DB_PATH);
        collected.push({
          path: 'data/fault_history_db.json',
          sizeBytes: histBuf.length,
          content: histBuf.toString('utf-8'),
          buffer: histBuf,
        });
      } catch {
        // Ignore if unreadable
      }
    }

    return collected;
  }

  // Save a ready-to-download ZIP snapshot AND static source bundle JSON in public/ on server startup
  try {
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    const initialFiles = collectProjectBackupFiles();
    const zipBuf = buildZipBuffer(
      initialFiles.map((f) => ({ name: f.path, data: f.buffer }))
    );
    fs.writeFileSync(
      path.join(publicDir, 'hydrodiag-ai-backup-completo.zip'),
      zipBuf
    );
    const totalBytes = initialFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
    const staticBundlePayload = {
      generatedAt: new Date().toISOString(),
      projectName: 'hydrodiag-ai-pch-uhe',
      totalFiles: initialFiles.length,
      totalBytes,
      files: initialFiles.map((f) => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
        content: f.content,
      })),
    };
    fs.writeFileSync(
      path.join(publicDir, 'hydrodiag-source-bundle.json'),
      JSON.stringify(staticBundlePayload),
      'utf-8'
    );
  } catch {
    // Ignore on read-only environments
  }

  app.get('/api/backup/source-bundle', (_req, res) => {
    try {
      const files = collectProjectBackupFiles();
      const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
      const bundlePayload = {
        generatedAt: new Date().toISOString(),
        projectName: 'hydrodiag-ai-pch-uhe',
        totalFiles: files.length,
        totalBytes,
        files: files.map((f) => ({
          path: f.path,
          sizeBytes: f.sizeBytes,
          content: f.content,
        })),
      };
      try {
        fs.writeFileSync(
          path.join(__dirname, 'public', 'hydrodiag-source-bundle.json'),
          JSON.stringify(bundlePayload),
          'utf-8'
        );
      } catch {
        // Ignore on read-only fs
      }
      return res.json(bundlePayload);
    } catch (err) {
      return res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao gerar pacote de backup do código-fonte.',
      });
    }
  });

  app.get('/api/backup/download-zip', (_req, res) => {
    try {
      const files = collectProjectBackupFiles();
      const zipBuffer = buildZipBuffer(
        files.map((f) => ({ name: f.path, data: f.buffer }))
      );
      const dateTag = new Date().toISOString().slice(0, 10);
      const filename = `hydrodiag-ai-codigo-completo-backup-${dateTag}.zip`;

      // Also refresh static copy in public/ if writable
      try {
        const publicZipPath = path.join(
          __dirname,
          'public',
          'hydrodiag-ai-backup-completo.zip'
        );
        fs.writeFileSync(publicZipPath, zipBuffer);
      } catch {
        // Ignore
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );
      res.setHeader('Content-Length', String(zipBuffer.length));
      return res.send(zipBuffer);
    } catch (err) {
      return res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Erro ao gerar arquivo ZIP de backup.',
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
      server: {
        middlewareMode: true,
        hmr: false,
      },
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
