import { PDFDocument } from 'pdf-lib';
import { DiagramAttachment } from '../types';

export interface PageBatchIndex {
  startPage: number;
  endPage: number;
  summary: string;
}

const PDF_INDEX_STORAGE_PREFIX = 'hydrodiag_pdf_idx_v2_';

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.includes(',') ? base64.split(',')[1] : base64;
  const binaryString = atob(clean);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

function getCacheKey(att: DiagramAttachment): string {
  const safeName = (att.name || 'pdf').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
  return `${PDF_INDEX_STORAGE_PREFIX}${att.sizeBytes}_${safeName}`;
}

export function getCachedPdfIndex(att: DiagramAttachment): PageBatchIndex[] | null {
  try {
    const raw = localStorage.getItem(getCacheKey(att));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function saveCachedPdfIndex(att: DiagramAttachment, index: PageBatchIndex[]) {
  try {
    localStorage.setItem(getCacheKey(att), JSON.stringify(index));
  } catch {
    // Ignore storage quota errors
  }
}

async function callServerlessStep(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/serverless-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Erro de comunicação com o servidor (HTTP ${res.status}). Verifique se a variável GEMINI_API_KEY está configurada.`
    );
  }
  if (!res.ok || data.ok === false) {
    throw new Error(
      String(data.error || `Falha na etapa de análise (HTTP ${res.status}).`)
    );
  }
  return data;
}

/**
 * Prepares compact, high-resolution multimodal parts in the browser so that
 * requests work 100% statelessly on Vercel Serverless Functions (under 4.5MB limit
 * and under serverless execution timeout) as well as local/Cloud Run environments.
 */
export async function prepareClientSmartAttachmentParts(
  att: DiagramAttachment,
  userQuery: string,
  focusTopic: string,
  onProgress?: (msg: string) => void,
  maxPages = 8
): Promise<{
  parts: unknown[];
  selectedPages: number[];
}> {
  if (!att.base64Data) {
    return { parts: [], selectedPages: [] };
  }

  // If image (JPG/PNG/WEBP), send directly
  if (att.mimeType !== 'application/pdf') {
    return {
      parts: [
        {
          inlineData: {
            mimeType: att.mimeType,
            data: att.base64Data,
          },
        },
      ],
      selectedPages: [1],
    };
  }

  const rawBytes = base64ToUint8Array(att.base64Data);
  const srcDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  // Small PDFs (<= 12 pages) can be sent directly if under 3MB
  if (totalPages <= 12 && rawBytes.byteLength <= 3 * 1024 * 1024) {
    return {
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: att.base64Data,
          },
        },
      ],
      selectedPages: Array.from({ length: totalPages }, (_, i) => i + 1),
    };
  }

  // Step 1: Get or build complete visual page index of the PDF (resumes from partial cache if available)
  const existingCached = getCachedPdfIndex(att) || [];
  const lastIndexedPage =
    existingCached.length > 0
      ? Math.max(...existingCached.map((b) => b.endPage))
      : 0;

  let pageIndex: PageBatchIndex[] = existingCached;

  if (lastIndexedPage < totalPages) {
    const batchSize = 10;
    const batches: PageBatchIndex[] = [...existingCached];

    const scanSingleBatch = async (startIdx: number): Promise<PageBatchIndex> => {
      const indices: number[] = [];
      for (let i = startIdx; i < Math.min(startIdx + batchSize, totalPages); i++) {
        indices.push(i);
      }
      const subDoc = await PDFDocument.create();
      const copied = await subDoc.copyPages(srcDoc, indices);
      copied.forEach((p) => subDoc.addPage(p));
      const subBytes = await subDoc.save();
      const subBase64 = uint8ArrayToBase64(subBytes);

      const startPage = indices[0] + 1;
      const endPage = indices[indices.length - 1] + 1;

      const stepRes = await callServerlessStep({
        action: 'index_batch',
        subPdfBase64: subBase64,
        startPage,
        endPage,
        pageCount: indices.length,
      });

      return {
        startPage,
        endPage,
        summary: String(stepRes.summary || ''),
      };
    };

    for (let s = lastIndexedPage; s < totalPages; s += 20) {
      const endRange = Math.min(s + 20, totalPages);
      if (onProgress) {
        onProgress(
          `Mapeando índice visual do caderno PDF (${att.name}): páginas ${s + 1} a ${endRange} de ${totalPages}...`
        );
      }
      const p1 = scanSingleBatch(s);
      const p2 = s + 10 < totalPages ? scanSingleBatch(s + 10) : Promise.resolve(null);
      const [r1, r2] = await Promise.all([p1, p2]);
      if (r1) batches.push(r1);
      if (r2) batches.push(r2);
      saveCachedPdfIndex(att, batches);
    }

    pageIndex = batches;
  }

  const fullIndexText = pageIndex
    .map(
      (b) =>
        `=== Lote Páginas PDF ${b.startPage} a ${b.endPage} ===\n${b.summary}`
    )
    .join('\n\n');

  // Step 2: Select the most relevant pages for the query
  if (onProgress) {
    onProgress(
      `Localizando folhas (/EL, /RB, /ME, /RM) para "${userQuery.slice(0, 45)}" nas ${totalPages} páginas...`
    );
  }

  let selectedPagesOneBased: number[] = [1, 2];
  try {
    const selRes = await callServerlessStep({
      action: 'select_pages',
      fileName: att.name,
      totalPages,
      fullIndexText,
      userQuery,
      focusTopic,
    });
    if (Array.isArray(selRes.selectedPages) && selRes.selectedPages.length > 0) {
      selectedPagesOneBased = (selRes.selectedPages as number[])
        .filter((n) => typeof n === 'number' && n >= 1 && n <= totalPages)
        .slice(0, maxPages);
    }
  } catch {
    selectedPagesOneBased = [1, 2, Math.min(30, totalPages), Math.min(50, totalPages)].slice(
      0,
      maxPages
    );
  }

  if (onProgress) {
    onProgress(
      `Recortando em alta resolução as páginas PDF selecionadas (${selectedPagesOneBased.join(', ')})...`
    );
  }

  // Step 3: Slice only the selected pages in browser so payload is < 900KB
  const subDoc = await PDFDocument.create();
  const zeroBasedIndices = selectedPagesOneBased.map((p) => p - 1);
  const copied = await subDoc.copyPages(srcDoc, zeroBasedIndices);
  copied.forEach((p) => subDoc.addPage(p));
  const subPdfBytes = await subDoc.save();
  const subPdfBase64 = uint8ArrayToBase64(subPdfBytes);

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
        text: `ÍNDICE COMPLETO DAS ${totalPages} PÁGINAS DO ARQUIVO "${att.name}":\n${fullIndexText}\n\n[ATENÇÃO: Para análise visual de alta precisão das coordenadas (Linha A-F, Coluna 1-8), contatos NA/NF e bornes, anexamos a seguir o recorte em alta resolução contendo as páginas mais relevantes do PDF original: ${pageMappingExplanation}. Ao citar o número da página do PDF na resposta, cite SEMPRE o número da página do PDF original!]`,
      },
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: subPdfBase64,
        },
      },
    ],
  };
}

/**
 * Converte expressões LaTeX e notações matemáticas técnicas (ex: $\Omega$, $< 2,\Omega$, $> 1,\text{k}\Omega$, $\mu\text{F}$, $\pm$)
 * em símbolos elétricos Unicode reais e limpos (Ω, menor que 2 Ω, maior que 1 kΩ, μF, ±, ≈, Δ, φ, etc.).
 */
export function formatTechnicalSymbols(rawText: string): string {
  if (!rawText) return '';

  const replaceLatexCommands = (input: string, isMathBlock = false): string => {
    let s = input;

    // 1. Espaçamentos LaTeX (\, \; \: \! \quad \qquad)
    s = s.replace(/\\[,;:!]/g, ' ');
    s = s.replace(/\\q?quad(?![a-zA-Z])/g, ' ');

    // 2. Vírgula usada como espaço fino antes de comando LaTeX (ex: "2,\Omega", "1,\text{k}\Omega")
    s = s.replace(
      /(\d)\s*,\s*(?=\\(?:Omega|omega|mu|micro|text|mathrm|mathit|mathbf|operatorname|unit|k|M|m)(?![a-zA-Z]))/g,
      '$1 '
    );

    // 3. Desempacotar \text{...}, \mathrm{...}, \mathit{...}, \operatorname{...}, \unit{...}
    for (let i = 0; i < 3; i++) {
      s = s.replace(
        /\\(?:text|mathrm|mathit|operatorname|unit|mbox)\s*\{([^{}]*)\}/g,
        '$1'
      );
      s = s.replace(/\\mathbf\s*\{([^{}]*)\}/g, '**$1**');
    }

    // 4. Frações e raízes quadradas
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1/$2)');
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    s = s.replace(/\\sqrt(?![a-zA-Z])/g, '√');

    // 5. Símbolos elétricos, letras gregas e operadores matemáticos
    const symbolMap: Array<[RegExp, string]> = [
      [/\\Omega(?![a-zA-Z])/g, 'Ω'],
      [/\\omega(?![a-zA-Z])/g, 'ω'],
      [/\\(?:mu|micro)(?![a-zA-Z])/g, 'μ'],
      [/\\Delta(?![a-zA-Z])/g, 'Δ'],
      [/\\delta(?![a-zA-Z])/g, 'δ'],
      [/\\Phi(?![a-zA-Z])/g, 'Φ'],
      [/\\(?:varphi|phi)(?![a-zA-Z])/g, 'φ'],
      [/\\Theta(?![a-zA-Z])/g, 'Θ'],
      [/\\(?:vartheta|theta)(?![a-zA-Z])/g, 'θ'],
      [/\\Lambda(?![a-zA-Z])/g, 'Λ'],
      [/\\lambda(?![a-zA-Z])/g, 'λ'],
      [/\\Sigma(?![a-zA-Z])/g, 'Σ'],
      [/\\sigma(?![a-zA-Z])/g, 'σ'],
      [/\\Pi(?![a-zA-Z])/g, 'Π'],
      [/\\pi(?![a-zA-Z])/g, 'π'],
      [/\\alpha(?![a-zA-Z])/g, 'α'],
      [/\\beta(?![a-zA-Z])/g, 'β'],
      [/\\gamma(?![a-zA-Z])/g, 'γ'],
      [/\\tau(?![a-zA-Z])/g, 'τ'],
      [/\\rho(?![a-zA-Z])/g, 'ρ'],
      [/\\eta(?![a-zA-Z])/g, 'η'],
      [/\\(?:varepsilon|epsilon)(?![a-zA-Z])/g, 'ε'],
      [/\\pm(?![a-zA-Z])/g, '±'],
      [/\\mp(?![a-zA-Z])/g, '∓'],
      [/\\times(?![a-zA-Z])/g, '×'],
      [/\\cdot(?![a-zA-Z])/g, '·'],
      [/\\div(?![a-zA-Z])/g, '÷'],
      [/\\approx(?![a-zA-Z])/g, '≈'],
      [/\\simeq(?![a-zA-Z])/g, '≃'],
      [/\\cong(?![a-zA-Z])/g, '≅'],
      [/\\equiv(?![a-zA-Z])/g, '≡'],
      [/\\sim(?![a-zA-Z])/g, '~'],
      [/\\(?:neq|ne)(?![a-zA-Z])/g, '≠'],
      [/\\(?:leq|le)(?![a-zA-Z])/g, ' menor ou igual a '],
      [/\\(?:geq|ge)(?![a-zA-Z])/g, ' maior ou igual a '],
      [/\\lt(?![a-zA-Z])/g, ' menor que '],
      [/\\gt(?![a-zA-Z])/g, ' maior que '],
      [/\\ll(?![a-zA-Z])/g, ' muito menor que '],
      [/\\gg(?![a-zA-Z])/g, ' muito maior que '],
      [/\\infty(?![a-zA-Z])/g, '∞'],
      [/\\Leftrightarrow(?![a-zA-Z])/g, '⇔'],
      [/\\Rightarrow(?![a-zA-Z])/g, '⇒'],
      [/\\Leftarrow(?![a-zA-Z])/g, '⇐'],
      [/\\leftrightarrow(?![a-zA-Z])/g, '↔'],
      [/\\(?:rightarrow|to)(?![a-zA-Z])/g, '→'],
      [/\\leftarrow(?![a-zA-Z])/g, '←'],
      [/\\uparrow(?![a-zA-Z])/g, '↑'],
      [/\\downarrow(?![a-zA-Z])/g, '↓'],
      [/\^\s*\{\\circ\}/g, '°'],
      [/\^\s*\\circ(?![a-zA-Z])/g, '°'],
      [/\\(?:circ|degree)(?![a-zA-Z])/g, '°'],
      [/\\angle(?![a-zA-Z])/g, '∠'],
      [/\\perp(?![a-zA-Z])/g, '⊥'],
      [/\\parallel(?![a-zA-Z])/g, '∥'],
      [/\\%/g, '%'],
    ];

    for (const [regex, replacement] of symbolMap) {
      s = s.replace(regex, replacement);
    }

    // 6. Sobrescritos e subscritos comuns
    s = s.replace(/\^\{2\}|\^2(?![0-9])/g, '²');
    s = s.replace(/\^\{3\}|\^3(?![0-9])/g, '³');
    s = s.replace(/\^\{-1\}/g, '⁻¹');
    s = s.replace(/_\{([^{}]+)\}/g, '$1');

    // 7. Vírgula residual antes de unidade elétrica já convertida (ex: "< 2,Ω" -> "< 2 Ω" ou "> 1,kΩ" -> "> 1 kΩ")
    s = s.replace(
      /(\d)\s*,\s*(?=(?:[kMmGμ]?Ω|(?:Vcc|Vca|Vac|Vdc|kV|mV|mA|kA|Hz|kW|MW|kVA|MVA|μF|mF|nF|pF)(?![a-zA-Z])))/g,
      '$1 '
    );

    // 8. Converter símbolos <, >, ≤, ≥ em texto por extenso ("menor que", "maior que")
    s = s.replace(/≤/g, ' menor ou igual a ');
    s = s.replace(/≥/g, ' maior ou igual a ');

    if (isMathBlock) {
      s = s.replace(/<=/g, ' menor ou igual a ');
      s = s.replace(/>=/g, ' maior ou igual a ');
      s = s.replace(/(?<![<\-=])<(?![=\->])/g, ' menor que ');
      s = s.replace(/(?<![>\-=])>(?![=\->])/g, ' maior que ');
    } else {
      // Fora de blocos $...$: converter (< 2 Ω), (> 1 kΩ), < 2 Ω, > 1 kΩ preservando blockquotes Markdown no início de linha e setas (->, =>)
      s = s.replace(/\(\s*<\s*/g, '(menor que ');
      s = s.replace(/\(\s*>\s*/g, '(maior que ');
      s = s.replace(/(?<![<\-=])<\s*(?=[+-]?\d|[ΩμΔφα-ωΑ-Ω])/g, 'menor que ');
      s = s.replace(/(?<!^|\n|[>\-=])>\s*(?=[+-]?\d|[ΩμΔφα-ωΑ-Ω])/g, 'maior que ');
    }

    // Limpar espaços duplicados ao redor de parênteses e palavras convertidas
    s = s.replace(/\(\s+(menor|maior)\b/g, '($1');
    s = s.replace(/ {2,}/g, ' ');

    return s;
  };

  let out = rawText;

  // Substituir blocos matemáticos $$...$$ e \[...\]
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) =>
    replaceLatexCommands(inner, true).replace(/\s+/g, ' ').trim()
  );
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) =>
    replaceLatexCommands(inner, true).replace(/\s+/g, ' ').trim()
  );

  // Substituir matemática inline $...$ e \(...\) (preservando R$ e US$)
  out = out.replace(/(?<![RUS])\$([^\n$]+?)\$/g, (_, inner) => {
    return replaceLatexCommands(inner, true)
      .replace(/~/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  });
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) =>
    replaceLatexCommands(inner, true).replace(/\s+/g, ' ').trim()
  );

  // Passada final para comandos LaTeX e comparadores soltos fora de $...$
  out = replaceLatexCommands(out, false);

  return out;
}

/**
 * Retorna a quantidade total de páginas de um PDF anexado em base64.
 */
export async function getPdfPageCount(base64Data: string): Promise<number> {
  if (!base64Data) return 1;
  try {
    const rawBytes = base64ToUint8Array(base64Data);
    const srcDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
    return Math.max(1, srcDoc.getPageCount());
  } catch {
    return 1;
  }
}

/**
 * Recorta cirurgicamente 1 única página (1-based) de um PDF anexado usando pdf-lib
 * e retorna uma Blob URL instantânea para visualização no Inspetor Deep-Link.
 * Isso garante abertura imediata na página exata mesmo em cadernos de 100+ folhas.
 */
export async function extractSinglePdfPageUrl(
  base64Data: string,
  pageNumberOneBased: number
): Promise<{
  blobUrl: string;
  totalPages: number;
  actualPage: number;
}> {
  const rawBytes = base64ToUint8Array(base64Data);
  const srcDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
  const totalPages = Math.max(1, srcDoc.getPageCount());
  const actualPage = Math.min(Math.max(1, pageNumberOneBased), totalPages);

  const singleDoc = await PDFDocument.create();
  const [copiedPage] = await singleDoc.copyPages(srcDoc, [actualPage - 1]);
  singleDoc.addPage(copiedPage);
  const singlePdfBytes = await singleDoc.save();

  const blob = new Blob([singlePdfBytes.buffer as ArrayBuffer], {
    type: 'application/pdf',
  });
  const blobUrl = URL.createObjectURL(blob);

  return {
    blobUrl,
    totalPages,
    actualPage,
  };
}

/**
 * Transforma citações de páginas e folhas no texto do Laudo ou Chat
 * (ex: "Página 12", "Pág. 49", "Folha 31", "Fl. 4") em links clicáveis
 * no formato `[texto](#pdf-page-N)` sem quebrar blocos de código ou links já existentes.
 */
export function linkifyPdfPageReferences(markdownText: string): string {
  if (!markdownText) return '';

  // Evitar alterar dentro de blocos de código ```...``` ou `...` ou links existentes [...] (...)
  const segments = markdownText.split(/(```[\s\S]*?```|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g);

  return segments
    .map((segment) => {
      if (
        segment.startsWith('```') ||
        segment.startsWith('`') ||
        (segment.startsWith('[') && segment.includes(']('))
      ) {
        return segment;
      }

      return segment.replace(
        /\b((?:P[áa]gina|P[áa]g\.?|Folha|Fl\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3}))\b/gi,
        (fullMatch, labelPart, numStr) => {
          const pageNum = parseInt(numStr, 10);
          if (isNaN(pageNum) || pageNum < 1 || pageNum > 999) {
            return fullMatch;
          }
          return `[${labelPart}](#pdf-page-${pageNum})`;
        }
      );
    })
    .join('');
}

export interface ProbeSummaryData {
  terminalStrip: string;
  redProbe: string;
  blackProbe: string;
  expectedValue: string;
  contactsOrComponent: string;
  locationPage: number | null;
  locationLabel: string;
}

/**
 * Extrai automaticamente do texto Markdown do laudo técnico os pontos de medição
 * com multímetro (Régua de Bornes, Ponta Vermelha +, Ponta Preta -, Valor Esperado,
 * Contatos NA/NF e Página/Folha de referência) para alimentar o Painel Visual de
 * "Ponta de Prova" no topo do laudo.
 */
export function extractProbeSummaryFromMarkdown(
  rawMarkdown: string
): ProbeSummaryData | null {
  if (!rawMarkdown || rawMarkdown.trim().length < 40) return null;

  const clean = formatTechnicalSymbols(rawMarkdown)
    .replace(/\*\*/g, '')
    .replace(/`/g, '');

  // 1. Isolar preferencialmente a seção 2 (Guia de Teste com Multímetro) quando existir
  const sec2Match = clean.match(
    /(?:Guia de Teste com Mult[íi]metro|Ponta de Prova)[\s\S]*?(?=\n### |\n## |$)/i
  );
  const targetBlock = sec2Match ? sec2Match[0] : clean;

  // 2. Extrair Régua de Bornes (ex: 1X2, 2X2, 3X2, 4X2, 3XD, XED, XSD, XB1, X1, X2)
  const stripMatches = Array.from(
    new Set(
      (
        clean.match(
          /\b(?:[1-9]X[0-9A-Z]{1,3}|XED\d*|XSD\d*|XAC\d*|XDC\d*|XB\d+|X[0-9]{1,2}| Bornes?\s+[A-Z0-9:-]{2,10})\b/gi
        ) || []
      ).map((m) => m.replace(/^Bornes?\s+/i, '').trim())
    )
  ).slice(0, 4);
  const terminalStrip =
    stripMatches.length > 0
      ? stripMatches.join(' · ')
      : 'Régua / Borne do Painel';

  // 3. Extrair Ponta de Prova Vermelha (+)
  let redProbe = '';
  const redRegexes = [
    /ponta\s+(?:de\s+prova\s+)?vermelha\s*(?:\(\+\)|\+)?\s*[:\-–]?\s*([^\n.;]{3,95})/i,
    /\(\+\)\s*(?:vermelha)?\s*[:\-–]\s*([^\n.;]{3,90})/i,
    /positivo\s*\(\+\)\s*[:\-–]?\s*([^\n.;]{3,85})/i,
  ];
  for (const rgx of redRegexes) {
    const m = targetBlock.match(rgx) || clean.match(rgx);
    if (m && m[1]) {
      redProbe = m[1].trim();
      break;
    }
  }
  if (!redProbe) {
    const borneMatch =
      targetBlock.match(
        /(?:borne|terminal|pino|entrada)\s+([A-Z0-9:.\-/]{1,18}(?:\s*\([^)\n]{1,30}\))?)/i
      ) ||
      clean.match(
        /(?:borne|terminal|pino|entrada)\s+([A-Z0-9:.\-/]{1,18})/i
      );
    redProbe = borneMatch
      ? `Borne / Terminal ${borneMatch[1].trim()}`
      : stripMatches[0]
        ? `Borne positivo na régua ${stripMatches[0]}`
        : 'Terminal de sinal / borne positivo (+) indicado no passo 2';
  }

  // 4. Extrair Ponta de Prova Preta (-)
  let blackProbe = '';
  const blackRegexes = [
    /ponta\s+(?:de\s+prova\s+)?preta\s*(?:\(-\)|-)?\s*[:\-–]?\s*([^\n.;]{3,95})/i,
    /\(-\)\s*(?:preta|refer[êe]ncia|comum)?\s*[:\-–]\s*([^\n.;]{3,90})/i,
    /negativo\s*\(-\)\s*[:\-–]?\s*([^\n.;]{3,85})/i,
  ];
  for (const rgx of blackRegexes) {
    const m = targetBlock.match(rgx) || clean.match(rgx);
    if (m && m[1]) {
      blackProbe = m[1].trim();
      break;
    }
  }
  if (!blackProbe) {
    const negMatch = clean.match(/\b(0Vcc|0V1|0V2|0V|N220|Terra|GND| barramento negativo)\b/i);
    blackProbe = negMatch
      ? `Referência ${negMatch[1]} (ou borne de saída do contato)`
      : 'Barramento Negativo (0Vcc / 0V1) ou borne comum de referência';
  }

  // 5. Extrair Tensões / Valores Esperados (ex: 125 Vcc, 24 Vcc, 220 Vca, menor que 2 Ω)
  const voltageTokens = Array.from(
    new Set(
      clean.match(
        /\b(?:\d{1,3}(?:[.,]\d+)?\s*(?:Vcc|Vca|Vac|Vdc|V|mA|Ω|kΩ|MΩ)|menor que \d+\s*Ω|maior que \d+\s*(?:kΩ|MΩ|Ω)|0\s*Vcc)\b/gi
      ) || []
    )
  ).slice(0, 4);
  const expectedValue =
    voltageTokens.length > 0
      ? voltageTokens.join(' / ')
      : '125 Vcc / 24 Vcc ou Continuidade (Ω)';

  // 6. Extrair Contatos NA/NF e Bobinas (13-14, 21-22, A1-A2, 89-5, 52G1)
  const contactTokens = Array.from(
    new Set(
      clean.match(
        /\b(?:13-14|21-22|23-24|31-32|33-34|41-42|43-44|53-54|61-62|71-72|83-84|95-96|97-98|A1-A2|89-[0-9]{1,2}|52G[12]?|86[A-Z0-9]*)\b/gi
      ) || []
    )
  ).slice(0, 5);
  const contactsOrComponent =
    contactTokens.length > 0
      ? contactTokens.join(' · ')
      : 'Contatos NA / NF e Bornes do Circuito';

  // 7. Extrair primeira Página / Folha e Coordenada citada para botão Deep-Link
  const pageMatch =
    clean.match(/\b(?:P[áa]gina|P[áa]g\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\b/i) ||
    clean.match(/\b(?:Folha|Fl\.?)\s*#?\s*(\d{1,3})\b/i);
  const locationPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  const coordMatch = clean.match(
    /\b(?:Coluna\s*[0-9]{1,2}|Linha\s*[A-F]|[0-9]{1,2}\/[A-F][0-9])\b/i
  );
  const locationLabel = locationPage
    ? `Pág. / Folha ${locationPage}${coordMatch ? ` (${coordMatch[0]})` : ''}`
    : coordMatch
      ? coordMatch[0]
      : 'Ver no Desenho';

  return {
    terminalStrip,
    redProbe,
    blackProbe,
    expectedValue,
    contactsOrComponent,
    locationPage: locationPage && !isNaN(locationPage) ? locationPage : null,
    locationLabel,
  };
}



