import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { DiagramAttachment } from '../types';

if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface PageBatchIndex {
  startPage: number;
  endPage: number;
  summary: string;
}

const PDF_INDEX_STORAGE_PREFIX = 'hydrodiag_pdf_idx_v2_';
const IDB_DB_NAME = 'hydrodiag_pdf_vault_v1';
const IDB_STORE_NAME = 'pdf_binaries';
const CACHE_STORAGE_NAME = 'hydrodiag_pdf_binary_cache_v2';

// Fast in-memory session cache keyed by normalized filename and attachment ID
const memoryVaultByName = new Map<string, string>();
let memoryLatestBase64: string | null = null;

function normalizeFileNameKey(name?: string): string {
  return (name || 'diagrama.pdf')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function deduplicateAttachments(
  list: DiagramAttachment[]
): DiagramAttachment[] {
  const byKey = new Map<string, DiagramAttachment>();
  for (const item of list) {
    const key = normalizeFileNameKey(item.name);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
    } else {
      // Merge: keep non-empty base64Data, prefer valid sizeBytes and panelName
      byKey.set(key, {
        ...existing,
        base64Data: existing.base64Data || item.base64Data || '',
        sizeBytes: existing.sizeBytes || item.sizeBytes || 0,
        panelName: existing.panelName || item.panelName,
        categoryTag: existing.categoryTag || item.categoryTag,
        serverUploadStatus:
          existing.base64Data || item.base64Data
            ? 'synced'
            : existing.serverUploadStatus,
      });
    }
  }
  return Array.from(byKey.values()).map((att, idx) => ({
    ...att,
    sequenceIndex: idx + 1,
  }));
}

function openPdfVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponível'));
      return;
    }
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getVaultSignatureKey(name: string, sizeBytes: number): string {
  return `sig__${normalizeFileNameKey(name)}__${sizeBytes || 0}`;
}

function getVaultNameKey(name: string): string {
  return `name__${normalizeFileNameKey(name)}`;
}

/**
 * Persists a PDF/image binary across 3 local layers:
 * 1) In-Memory Map (instant)
 * 2) Browser CacheStorage API as native binary Response (handles 5MB-100MB PDFs with zero IPC string limit)
 * 3) Browser IndexedDB as compact Uint8Array binary
 */
export async function saveAttachmentBinaryToVault(
  att: Pick<DiagramAttachment, 'id' | 'name' | 'sizeBytes' | 'base64Data'>
): Promise<void> {
  if (!att.base64Data) return;
  const cleanB64 = att.base64Data.includes(',')
    ? att.base64Data.split(',')[1]
    : att.base64Data;
  if (!cleanB64) return;

  const normName = normalizeFileNameKey(att.name);
  memoryVaultByName.set(normName, cleanB64);
  if (att.id) memoryVaultByName.set(`id__${att.id}`, cleanB64);
  memoryLatestBase64 = cleanB64;

  let rawBytes: Uint8Array | null = null;
  try {
    rawBytes = base64ToUint8Array(cleanB64);
  } catch {
    rawBytes = null;
  }

  // Layer 1: Browser CacheStorage API (Native Binary Stream — immune to V8 string/IPC limits)
  if (rawBytes && typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_STORAGE_NAME);
      const urls = [
        `https://hydrodiag.local/pdf/name/${encodeURIComponent(normName)}`,
        `https://hydrodiag.local/pdf/sig/${encodeURIComponent(normName)}__${att.sizeBytes || rawBytes.byteLength}`,
        `https://hydrodiag.local/pdf/latest`,
      ];
      if (att.id) {
        urls.push(`https://hydrodiag.local/pdf/id/${encodeURIComponent(att.id)}`);
      }
      for (const u of urls) {
        const copyBuf = new Uint8Array(rawBytes);
        await cache.put(
          u,
          new Response(copyBuf.buffer, {
            headers: {
              'Content-Type': 'application/pdf',
              'X-File-Name': encodeURIComponent(normName),
            },
          })
        );
      }
    } catch {
      // Ignore CacheStorage errors
    }
  }

  // Layer 2: Browser IndexedDB (Single compact Uint8Array write per transaction)
  try {
    const db = await openPdfVaultDb();
    const payloadToStore: Uint8Array | string = rawBytes || cleanB64;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_STORE_NAME);
      store.put(payloadToStore, getVaultNameKey(normName));
      store.put(payloadToStore, 'latest__pdf');
      if (att.sizeBytes) {
        store.put(
          payloadToStore,
          getVaultSignatureKey(normName, att.sizeBytes)
        );
      }
      if (att.id) {
        store.put(payloadToStore, `id__${att.id}`);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore IndexedDB quota or private browsing restrictions
  }
}

export async function loadAttachmentBinaryFromVault(
  att: Pick<DiagramAttachment, 'id' | 'name' | 'sizeBytes'>
): Promise<string | null> {
  const normName = normalizeFileNameKey(att.name);

  // 0. Check fast in-memory map first
  if (att.id && memoryVaultByName.has(`id__${att.id}`)) {
    return memoryVaultByName.get(`id__${att.id}`) || null;
  }
  if (normName && memoryVaultByName.has(normName)) {
    return memoryVaultByName.get(normName) || null;
  }

  // 1. Check Browser CacheStorage API (Native Binary)
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_STORAGE_NAME);
      const candidateUrls = [
        `https://hydrodiag.local/pdf/name/${encodeURIComponent(normName)}`,
        `https://hydrodiag.local/pdf/sig/${encodeURIComponent(normName)}__${att.sizeBytes || 0}`,
        ...(att.id
          ? [`https://hydrodiag.local/pdf/id/${encodeURIComponent(att.id)}`]
          : []),
        `https://hydrodiag.local/pdf/latest`,
      ];

      for (const url of candidateUrls) {
        const match = await cache.match(url);
        if (match) {
          const buf = await match.arrayBuffer();
          if (buf && buf.byteLength > 100) {
            const b64 = uint8ArrayToBase64(new Uint8Array(buf));
            memoryVaultByName.set(normName, b64);
            return b64;
          }
        }
      }

      // Wildcard CacheStorage scan if exact URL didn't match
      const allCacheRequests = await cache.keys();
      for (const req of allCacheRequests) {
        if (
          req.url.includes(encodeURIComponent(normName)) ||
          allCacheRequests.length > 0
        ) {
          const match = await cache.match(req);
          if (match) {
            const buf = await match.arrayBuffer();
            if (buf && buf.byteLength > 100) {
              const b64 = uint8ArrayToBase64(new Uint8Array(buf));
              memoryVaultByName.set(normName, b64);
              return b64;
            }
          }
        }
      }
    } catch {
      // Ignore CacheStorage read errors
    }
  }

  // 2. Check Browser IndexedDB (supports both Uint8Array, legacy base64 string, legacy keys, and full cursor scan)
  try {
    const db = await openPdfVaultDb();
    const decodeIdbVal = (res: unknown): string | null => {
      if (!res) return null;
      if (typeof res === 'string' && res.length > 100) return res;
      if (res instanceof Uint8Array && res.byteLength > 100) {
        return uint8ArrayToBase64(res);
      }
      if (res instanceof ArrayBuffer && res.byteLength > 100) {
        return uint8ArrayToBase64(new Uint8Array(res));
      }
      return null;
    };

    const readKey = (key: string): Promise<string | null> =>
      new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE_NAME, 'readonly');
        const store = tx.objectStore(IDB_STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(decodeIdbVal(req.result));
        req.onerror = () => resolve(null);
      });

    const rawLowerName = (att.name || '').trim().toLowerCase();
    const keysToTry = [
      getVaultNameKey(normName),
      `name_only_${normName}`,
      `name_only_${rawLowerName}`,
      ...(att.sizeBytes
        ? [
            getVaultSignatureKey(normName, att.sizeBytes),
            `name_size_${normName}_${att.sizeBytes}`,
            `name_size_${rawLowerName}_${att.sizeBytes}`,
          ]
        : []),
      ...(att.id ? [`id__${att.id}`] : []),
      'latest__pdf',
    ];

    for (const k of keysToTry) {
      const found = await readKey(k);
      if (found) {
        db.close();
        memoryVaultByName.set(normName, found);
        return found;
      }
    }

    // Cursor scan fallback: find any stored PDF matching filename or any valid PDF in the vault
    const scannedResult = await new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_NAME, 'readonly');
        const store = tx.objectStore(IDB_STORE_NAME);
        const cursorReq = store.openCursor();
        let fallbackAnyPdf: string | null = null;

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve(fallbackAnyPdf);
            return;
          }
          const keyStr = String(cursor.key || '').toLowerCase();
          const decoded = decodeIdbVal(cursor.value);
          if (decoded) {
            if (normName && keyStr.includes(normName)) {
              resolve(decoded);
              return;
            }
            if (!fallbackAnyPdf) {
              fallbackAnyPdf = decoded;
            }
          }
          cursor.continue();
        };
        cursorReq.onerror = () => resolve(fallbackAnyPdf);
      } catch {
        resolve(null);
      }
    });

    db.close();
    if (scannedResult) {
      memoryVaultByName.set(normName, scannedResult);
      // Migrate to fast CacheStorage in background
      saveAttachmentBinaryToVault({
        id: att.id,
        name: att.name,
        sizeBytes: att.sizeBytes,
        base64Data: scannedResult,
      }).catch(() => {});
      return scannedResult;
    }
  } catch {
    // Ignore IndexedDB read errors
  }

  // 3. Fallback: Fetch in chunks from Server / Supabase Cloud PDF Vault (/api/attachments/fetch-binary)
  try {
    const buildParams = (chunkIdx: number) => {
      const p = new URLSearchParams();
      if (att.id) p.set('id', att.id);
      if (att.name) p.set('name', att.name);
      if (att.sizeBytes) p.set('sizeBytes', String(att.sizeBytes));
      p.set('chunkIndex', String(chunkIdx));
      return p.toString();
    };

    const firstRes = await fetch(
      `/api/attachments/fetch-binary?${buildParams(0)}`
    );
    if (firstRes.ok) {
      const firstData = await firstRes.json();
      if (firstData && firstData.ok) {
        let fullBase64 = '';
        if (
          typeof firstData.base64Data === 'string' &&
          firstData.base64Data.length > 0
        ) {
          fullBase64 = firstData.base64Data;
        } else if (
          typeof firstData.chunkData === 'string' &&
          typeof firstData.totalChunks === 'number'
        ) {
          const chunks: string[] = [firstData.chunkData];
          const totalChunks = firstData.totalChunks;
          for (let c = 1; c < totalChunks; c++) {
            const cRes = await fetch(
              `/api/attachments/fetch-binary?${buildParams(c)}`
            );
            if (!cRes.ok) {
              chunks.length = 0;
              break;
            }
            const cData = await cRes.json();
            if (!cData?.ok || typeof cData.chunkData !== 'string') {
              chunks.length = 0;
              break;
            }
            chunks.push(cData.chunkData);
          }
          if (chunks.length === totalChunks) {
            fullBase64 = chunks.join('');
          }
        }

        if (fullBase64.length > 100) {
          await saveAttachmentBinaryToVault({
            id: att.id,
            name: att.name,
            sizeBytes: att.sizeBytes,
            base64Data: fullBase64,
          });
          return fullBase64;
        }
      }
    }
  } catch {
    // Ignore network fallback error
  }

  if (memoryLatestBase64) {
    return memoryLatestBase64;
  }

  return null;
}

export async function hydrateAttachmentsFromVault(
  list: DiagramAttachment[]
): Promise<DiagramAttachment[]> {
  const deduped = deduplicateAttachments(list);
  const hydrated = await Promise.all(
    deduped.map(async (item) => {
      if (item.base64Data && item.base64Data.length > 100) {
        await saveAttachmentBinaryToVault(item);
        return item;
      }
      const restoredBase64 = await loadAttachmentBinaryFromVault(item);
      if (restoredBase64) {
        return {
          ...item,
          base64Data: restoredBase64,
          serverUploadStatus: 'synced' as const,
          uploadProgress: 100,
        };
      }
      return item;
    })
  );
  return hydrated;
}

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

function getCacheKey(att: Pick<DiagramAttachment, 'name' | 'sizeBytes'>): string {
  const safeName = (att.name || 'pdf').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
  return `${PDF_INDEX_STORAGE_PREFIX}${att.sizeBytes}_${safeName}`;
}

export function getCachedPdfIndex(
  att: Pick<DiagramAttachment, 'name' | 'sizeBytes'>
): PageBatchIndex[] | null {
  try {
    const exactRaw = localStorage.getItem(getCacheKey(att));
    if (exactRaw) {
      const parsed = JSON.parse(exactRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }

    // Fallback: match by safeName suffix or any stored index in localStorage
    const safeName = (att.name || 'pdf')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 32)
      .toLowerCase();
    let anyValidIndex: PageBatchIndex[] | null = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PDF_INDEX_STORAGE_PREFIX)) continue;
      const rawVal = localStorage.getItem(k);
      if (!rawVal) continue;
      const parsed = JSON.parse(rawVal);
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (k.toLowerCase().endsWith(safeName)) {
          return parsed;
        }
        if (!anyValidIndex) {
          anyValidIndex = parsed;
        }
      }
    }
    return anyValidIndex;
  } catch {
    // Ignore storage read errors
  }
  return null;
}

export interface ReconstructedSheetPageEntry {
  pdfPage: number;
  folhaSelo: string;
  titulo: string;
  tags: string;
}

export interface ReconstructedSheetInfo {
  totalPages: number;
  folhaSelo: string;
  tituloFolha: string;
  tagsPrincipais: string;
  batchPages: ReconstructedSheetPageEntry[];
  reportCitationsForPage: string[];
  extractedCoordinates: string[];
  extractedBornesAndTags: string[];
}

/**
 * Analisa os lotes indexados em cache (tanto no formato compacto `21|FL. 19|TITULO`
 * gerado pelo backend quanto no formato verboso `PAGINA_PDF: 21 | FOLHA_SELO: ...`)
 */
export function parseCachedIndexEntries(
  cachedBatches: PageBatchIndex[] | null | undefined
): ReconstructedSheetPageEntry[] {
  if (!cachedBatches || cachedBatches.length === 0) return [];
  const entries: ReconstructedSheetPageEntry[] = [];
  const seenPages = new Set<number>();

  for (const batch of cachedBatches) {
    if (!batch?.summary) continue;

    // 1. Formato verboso: PAGINA_PDF: X | FOLHA_SELO: Y | TITULO: Z | TAGS PRINCIPAIS: W
    const verboseRegex =
      /PAGINA_PDF:\s*(\d+)\s*\|\s*FOLHA_SELO:\s*([^|\n]+?)\s*\|\s*T[ÍI]TULO:\s*([^|\n]+?)\s*\|\s*TAGs?\s*PRINCIPAIS?:\s*([^\n|]+?)(?=\s+PAGINA_PDF:|\s*$)/gi;
    let m: RegExpExecArray | null;
    while ((m = verboseRegex.exec(batch.summary)) !== null) {
      const pg = parseInt(m[1], 10);
      if (!isNaN(pg) && !seenPages.has(pg)) {
        seenPages.add(pg);
        entries.push({
          pdfPage: pg,
          folhaSelo: m[2].trim(),
          titulo: m[3].trim(),
          tags: m[4].trim(),
        });
      }
    }

    // 2. Formato compacto retornado pelo index_batch do servidor: 31|FL. 29|DIAGRAMA FUNCIONAL...
    const lines = batch.summary.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[\s*•\-–]+/, '').trim();
      if (!line || /^PAGINA_PDF/i.test(line)) continue;
      const pipeMatch = line.match(
        /^(\d{1,4})\s*\|\s*([^|]+?)\s*\|\s*(.+)$/
      );
      if (pipeMatch) {
        const pg = parseInt(pipeMatch[1], 10);
        if (!isNaN(pg) && !seenPages.has(pg)) {
          seenPages.add(pg);
          const rawFolha = pipeMatch[2].trim();
          const restParts = pipeMatch[3].split('|').map((s) => s.trim());
          const titulo = restParts[0] || `DIAGRAMA — PÁGINA ${pg}`;
          const tags = restParts.slice(1).join(' · ') || titulo;
          entries.push({
            pdfPage: pg,
            folhaSelo: rawFolha,
            titulo,
            tags,
          });
        }
      }
    }
  }

  return entries.sort((a, b) => a.pdfPage - b.pdfPage);
}

export interface FolhaToPdfPageLookup {
  folhaToPdfPage: Map<number, number>;
  pdfPageToFolha: Map<number, number>;
  modalOffset: number | null;
}

/**
 * Constrói o mapa bidirecional entre o número da Folha no Selo WEG (`FL. 29` / `Folha 29`)
 * e o número real da Página no arquivo PDF (`Página 31`), combinando o índice de páginas
 * do PDF e os pares explícitos citados no texto do diagnóstico.
 */
export function buildFolhaToPdfPageLookup(
  rawMarkdown?: string,
  cachedBatches?: PageBatchIndex[] | null
): FolhaToPdfPageLookup {
  const folhaToPdfPage = new Map<number, number>();
  const pdfPageToFolha = new Map<number, number>();
  const offsetCounts = new Map<number, number>();

  const recordPair = (folhaNum: number, pdfPageNum: number) => {
    if (
      isNaN(folhaNum) ||
      isNaN(pdfPageNum) ||
      folhaNum < 1 ||
      pdfPageNum < 1 ||
      folhaNum > 2000 ||
      pdfPageNum > 2000
    ) {
      return;
    }
    if (!folhaToPdfPage.has(folhaNum)) {
      folhaToPdfPage.set(folhaNum, pdfPageNum);
    }
    if (!pdfPageToFolha.has(pdfPageNum)) {
      pdfPageToFolha.set(pdfPageNum, folhaNum);
    }
    const diff = pdfPageNum - folhaNum;
    if (diff >= 0 && diff <= 25) {
      offsetCounts.set(diff, (offsetCounts.get(diff) || 0) + 1);
    }
  };

  // 1. Pares vindos do índice em cache do PDF (ex: 31|FL. 29|...)
  const entries = parseCachedIndexEntries(cachedBatches);
  for (const entry of entries) {
    const flMatch = entry.folhaSelo.match(/(\d{1,4})/);
    if (flMatch) {
      const flNum = parseInt(flMatch[1], 10);
      recordPair(flNum, entry.pdfPage);
    }
  }

  // 2. Pares explícitos citados no texto do Laudo/Chat (ex: "Folha Selo FL. 29 / Página 31" ou "Página 31 (FL. 29)")
  if (rawMarkdown) {
    const clean = rawMarkdown.replace(/\*\*/g, '').replace(/`/g, '');

    // Padrão A: Folha [Selo] [FL.] X ... Página Y
    const rgxFolhaFirst =
      /\b(?:Folha(?:\s+do\s+Selo|\s+Selo)?(?:\s+FL\.?)?|Fl\.?)\s*#?\s*(\d{1,3})\s*(?:\/|\(|—|–|-|,|\s+na\s+|\s+da\s+|\s+correspondente\s+[àa]\s+|\s+que\s+[ée]\s+a\s+)\s*P[áa]g(?:ina)?\.?\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\b/gi;
    let m: RegExpExecArray | null;
    while ((m = rgxFolhaFirst.exec(clean)) !== null) {
      recordPair(parseInt(m[1], 10), parseInt(m[2], 10));
    }

    // Padrão B: Página Y ... Folha [Selo] [FL.] X
    const rgxPageFirst =
      /\bP[áa]g(?:ina)?\.?\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\s*(?:do\s+PDF\s*)?(?:\s+Original\s*)?(?:\/|\(|—|–|-|,|\s+selo\s+|\s+correspondente\s+[àa]\s+)\s*(?:Folha(?:\s+do\s+Selo|\s+Selo)?\s*)?(?:FL\.?\s*)?#?\s*(\d{1,3})\b/gi;
    while ((m = rgxPageFirst.exec(clean)) !== null) {
      recordPair(parseInt(m[2], 10), parseInt(m[1], 10));
    }
  }

  // Determinar o offset modal (ex: +2 em cadernos WEG com capa + índice)
  let modalOffset: number | null = null;
  let bestCount = 0;
  for (const [offset, count] of offsetCounts.entries()) {
    if (count > bestCount || (count === bestCount && offset > 0 && (modalOffset === 0 || modalOffset === null))) {
      bestCount = count;
      modalOffset = offset;
    }
  }

  return {
    folhaToPdfPage,
    pdfPageToFolha,
    modalOffset,
  };
}

/**
 * Resolve qualquer número citado (seja `Página Y` ou `Folha / FL. X`) para o
 * número EXATO da página física do arquivo PDF.
 */
export function resolveCitationToPdfPage(
  citedNumber: number,
  isFolhaCitation: boolean,
  rawMarkdown?: string,
  cachedBatches?: PageBatchIndex[] | null
): { pdfPage: number; folhaSelo?: number } {
  const lookup = buildFolhaToPdfPageLookup(rawMarkdown, cachedBatches);

  if (!isFolhaCitation) {
    const knownFolha =
      lookup.pdfPageToFolha.get(citedNumber) ??
      (lookup.modalOffset !== null &&
      lookup.modalOffset > 0 &&
      citedNumber > lookup.modalOffset
        ? citedNumber - lookup.modalOffset
        : undefined);
    return {
      pdfPage: citedNumber,
      folhaSelo: knownFolha,
    };
  }

  // É uma citação de Folha / FL. (ex: FL. 29 ou Folha 29)
  const exactPdfPage = lookup.folhaToPdfPage.get(citedNumber);
  if (exactPdfPage !== undefined) {
    return {
      pdfPage: exactPdfPage,
      folhaSelo: citedNumber,
    };
  }

  if (lookup.modalOffset !== null && lookup.modalOffset > 0) {
    return {
      pdfPage: citedNumber + lookup.modalOffset,
      folhaSelo: citedNumber,
    };
  }

  return {
    pdfPage: citedNumber,
    folhaSelo: citedNumber,
  };
}

export function extractReconstructedPageSheetData(
  pageNumber: number,
  attachmentName: string,
  cachedBatches: PageBatchIndex[] | null,
  reportMarkdown?: string
): ReconstructedSheetInfo {
  const maxBatchPage =
    cachedBatches && cachedBatches.length > 0
      ? Math.max(...cachedBatches.map((b) => b.endPage))
      : 0;
  const totalPages = Math.max(maxBatchPage, pageNumber, 1);

  const allParsedEntries = parseCachedIndexEntries(cachedBatches);
  const matchingBatch = cachedBatches?.find(
    (b) => pageNumber >= b.startPage && pageNumber <= b.endPage
  );
  const batchPages = matchingBatch
    ? allParsedEntries.filter(
        (e) =>
          e.pdfPage >= matchingBatch.startPage &&
          e.pdfPage <= matchingBatch.endPage
      )
    : allParsedEntries;

  const exactEntry = allParsedEntries.find((e) => e.pdfPage === pageNumber);
  const lookup = buildFolhaToPdfPageLookup(reportMarkdown, cachedBatches);
  const mappedFolhaNum = lookup.pdfPageToFolha.get(pageNumber);

  const folhaSelo =
    exactEntry?.folhaSelo ||
    (mappedFolhaNum !== undefined
      ? `FL. ${String(mappedFolhaNum).padStart(2, '0')}`
      : lookup.modalOffset !== null &&
          lookup.modalOffset > 0 &&
          pageNumber > lookup.modalOffset
        ? `FL. ${String(pageNumber - lookup.modalOffset).padStart(2, '0')}`
        : String(pageNumber));

  const tituloFolha =
    exactEntry?.titulo ||
    `DIAGRAMA ESQUEMÁTICO / FUNCIONAL — PÁGINA ${pageNumber}`;
  const tagsPrincipais =
    exactEntry?.tags ||
    attachmentName.replace(/\.pdf$/i, '').toUpperCase();

  const cleanReport = (reportMarkdown || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '');
  const lines = cleanReport
    .split(/\n+/)
    .map((l) => l.replace(/^[\s*•\-–]+/, '').trim())
    .filter((l) => l.length > 15);

  const folhaNumeric = folhaSelo.match(/(\d{1,4})/)?.[1];
  const pageRgx = new RegExp(
    `\\b(?:P[áa]gina|P[áa]g\\.?|Folha|Fl\\.?)\\s*(?:Selo\\s*)?(?:FL\\.?\\s*)?#?\\s*(?:${pageNumber}${
      folhaNumeric && folhaNumeric !== String(pageNumber)
        ? `|${folhaNumeric}`
        : ''
    })\\b`,
    'i'
  );

  let reportCitationsForPage = lines.filter((l) => pageRgx.test(l));
  if (reportCitationsForPage.length === 0) {
    reportCitationsForPage = lines
      .filter((l) =>
        /\b(?:Borne|R[ée]gua|Coluna|Coordenada|CLP|Sinal|Contato| Cabo)\b/i.test(
          l
        )
      )
      .slice(0, 5);
  }

  const combinedContext = `${reportCitationsForPage.join(' ')} ${cleanReport}`;
  const extractedCoordinates = Array.from(
    new Set(
      combinedContext.match(
        /\b(?:Coluna\s*[0-9]{1,2}|Coordenada\s*[A-F][0-9]|Linha\s*[A-F]|[A-F][1-8])\b/gi
      ) || ['Coluna 4', 'Coordenada B4']
    )
  ).slice(0, 4);

  const extractedBornesAndTags = Array.from(
    new Set(
      combinedContext.match(
        /\b(?:[1-9]?X[0-9A-Z]{1,3}|Bornes?\s+[0-9,\s e]{1,16}|A[0-9]{2}\.[0-9]|GRV[0-9/]+|PCPG[12]?[+A-Z]*|CLP-SASE|RV|UHLM|QDCC)\b/gi
      ) || [tagsPrincipais]
    )
  ).slice(0, 8);

  return {
    totalPages,
    folhaSelo,
    tituloFolha,
    tagsPrincipais,
    batchPages,
    reportCitationsForPage,
    extractedCoordinates,
    extractedBornesAndTags,
  };
}

function saveCachedPdfIndex(
  att: Pick<DiagramAttachment, 'name' | 'sizeBytes'>,
  index: PageBatchIndex[]
) {
  try {
    localStorage.setItem(getCacheKey(att), JSON.stringify(index));
  } catch {
    // Ignore storage quota errors
  }
}

async function callServerlessStep(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/serverless-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = (await res.text()).trim();
    if (!text && attempt === 0) {
      continue;
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      if (attempt === 0) continue;
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
  throw new Error('Tempo limite excedido na etapa de indexação.');
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
  maxPages = 5
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

  // Small PDFs (<= 8 pages) can be sent directly if under 1.5MB
  if (totalPages <= 8 && rawBytes.byteLength <= 1.5 * 1024 * 1024) {
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

  // Step 3: Slice only the selected pages in browser and ensure compact payload (< 1.8MB) for fast serverless execution
  const buildSlicedPdfBytes = async (pagesToSlice: number[]) => {
    const subDoc = await PDFDocument.create();
    const zeroBasedIndices = pagesToSlice.map((p) => p - 1);
    const copied = await subDoc.copyPages(srcDoc, zeroBasedIndices);
    copied.forEach((p) => subDoc.addPage(p));
    return subDoc.save();
  };

  let subPdfBytes = await buildSlicedPdfBytes(selectedPagesOneBased);
  if (subPdfBytes.byteLength > 1.8 * 1024 * 1024 && selectedPagesOneBased.length > 3) {
    selectedPagesOneBased = selectedPagesOneBased.slice(0, 3);
    subPdfBytes = await buildSlicedPdfBytes(selectedPagesOneBased);
  }
  if (subPdfBytes.byteLength > 2.2 * 1024 * 1024 && selectedPagesOneBased.length > 2) {
    selectedPagesOneBased = selectedPagesOneBased.slice(0, 2);
    subPdfBytes = await buildSlicedPdfBytes(selectedPagesOneBased);
  }

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
  pageImageUrl: string | null;
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

  // Render high-resolution raster sheet (2.5x scale) so CAD Pan ("Mãozinha") and Mouse Zoom work directly on the drawing
  let pageImageUrl: string | null = null;
  try {
    if (typeof document !== 'undefined') {
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(singlePdfBytes),
      });
      const pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const viewport = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        await page.render({
          canvasContext: ctx,
          viewport,
        }).promise;
        pageImageUrl = canvas.toDataURL('image/png');
      }
      await loadingTask.destroy();
    }
  } catch {
    pageImageUrl = null;
  }

  return {
    blobUrl,
    pageImageUrl,
    totalPages,
    actualPage,
  };
}

/**
 * Transforma citações de páginas e folhas no texto do Laudo ou Chat
 * (ex: "Página 31", "Pág. 49", "Folha 29", "FL. 29") em links clicáveis
 * no formato `[texto](#pdf-page-N)` apontando SEMPRE para a página física real do PDF
 * (resolvendo automaticamente a diferença entre Folha do Selo WEG e Página do PDF).
 */
export function linkifyPdfPageReferences(
  markdownText: string,
  cachedBatches?: PageBatchIndex[] | null
): string {
  if (!markdownText) return '';

  // Evitar alterar dentro de blocos de código ```...``` ou `...` ou links existentes [...] (...)
  const segments = markdownText.split(
    /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g
  );

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
        /\b((?:P[áa]gina|P[áa]g\.?|Folha(?:\s+do\s+Selo|\s+Selo)?(?:\s+FL\.?)?|Fl\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3}))\b/gi,
        (fullMatch, labelPart, numStr) => {
          const citedNum = parseInt(numStr, 10);
          if (isNaN(citedNum) || citedNum < 1 || citedNum > 999) {
            return fullMatch;
          }
          const isFolha = /^(?:Folha|Fl\.?)/i.test(labelPart.trim());
          const resolved = resolveCitationToPdfPage(
            citedNum,
            isFolha,
            markdownText,
            cachedBatches
          );
          return `[${labelPart}](#pdf-page-${resolved.pdfPage})`;
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
  // Prioriza número explícito de "Página" no bloco de teste; se encontrar apenas "Folha / FL.", converte para a Página real do PDF!
  const explicitPageInBlock = targetBlock.match(
    /\b(?:P[áa]gina|P[áa]g\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\b/i
  );
  const explicitPageInClean = clean.match(
    /\b(?:P[áa]gina|P[áa]g\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\b/i
  );
  const explicitFolhaMatch =
    targetBlock.match(
      /\b(?:Folha(?:\s+Selo)?(?:\s+FL\.?)?|Fl\.?)\s*#?\s*(\d{1,3})\b/i
    ) ||
    clean.match(
      /\b(?:Folha(?:\s+Selo)?(?:\s+FL\.?)?|Fl\.?)\s*#?\s*(\d{1,3})\b/i
    );

  let locationPage: number | null = null;
  let locationFolha: number | undefined = undefined;

  if (explicitPageInBlock || explicitPageInClean) {
    const rawPg = parseInt(
      (explicitPageInBlock || explicitPageInClean)![1],
      10
    );
    const resolved = resolveCitationToPdfPage(rawPg, false, rawMarkdown);
    locationPage = resolved.pdfPage;
    locationFolha =
      resolved.folhaSelo ??
      (explicitFolhaMatch ? parseInt(explicitFolhaMatch[1], 10) : undefined);
  } else if (explicitFolhaMatch) {
    const rawFl = parseInt(explicitFolhaMatch[1], 10);
    const resolved = resolveCitationToPdfPage(rawFl, true, rawMarkdown);
    locationPage = resolved.pdfPage;
    locationFolha = resolved.folhaSelo;
  }

  const coordMatch = clean.match(
    /\b(?:Coluna\s*[0-9]{1,2}|Linha\s*[A-F]|[0-9]{1,2}\/[A-F][0-9])\b/i
  );
  const folhaSuffix =
    locationFolha && locationFolha !== locationPage
      ? ` / FL. ${locationFolha}`
      : '';
  const locationLabel = locationPage
    ? `Pág. ${locationPage}${folhaSuffix}${coordMatch ? ` (${coordMatch[0]})` : ''}`
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

export interface SignalChainNode {
  stepNumber: number;
  panelOrStage: string;
  categoryTag: string;
  detailOrTerminals: string;
  fileName?: string;
  status: 'verified' | 'current' | 'next_target';
}

/**
 * Constrói a Linha do Tempo Visual de Rastreamento entre Painéis ("Cadeia de Sinal",
 * ex: PCPG1 → CLP-SASE → QDCC → UHLM) combinando os arquivos PDF anexados na sequência
 * e os painéis/bornes detectados no texto do Laudo Técnico.
 */
export function extractSignalChainFromContext(
  attachments: DiagramAttachment[],
  rawMarkdown?: string
): SignalChainNode[] {
  const nodes: SignalChainNode[] = [];
  const cleanMd = rawMarkdown
    ? formatTechnicalSymbols(rawMarkdown).replace(/\*\*/g, '').replace(/`/g, '')
    : '';

  // 1. Adicionar nós correspondentes aos cadernos/desenhos anexados na sequência
  attachments.forEach((att, idx) => {
    const inferredPanel =
      att.panelName?.trim() ||
      (att.name.match(
        /\b(PCPG[12]?|CLP-SASE|SASE|QDCC|QDSA|QDF|QGBT|UHLM|UCR|CSG[12]?|GMG|SRV|RV)\b/i
      )?.[0]?.toUpperCase() ??
        `Desenho #${att.sequenceIndex}`);

    nodes.push({
      stepNumber: idx + 1,
      panelOrStage: inferredPanel,
      categoryTag: att.categoryTag,
      detailOrTerminals: att.name,
      fileName: att.name,
      status: idx === attachments.length - 1 ? 'current' : 'verified',
    });
  });

  // 2. Extrair painéis e réguas citados no Laudo Técnico que complementam a cadeia
  if (cleanMd) {
    const knownPanelOrder = [
      {
        tag: 'UHLM / Campo',
        regex: /\b(?:UHLM|Pressostato|Sensor de Campo| solenoide|63[A-Z0-9]*|PT100)\b/i,
        cat: '/EL · Campo',
        desc: 'Instrumentação / Dispositivo de Campo',
      },
      {
        tag: 'PCPG1 / PCPG2',
        regex: /\b(?:PCPG[12]?|Painel de Controle e Prote[çc][ãa]o)\b/i,
        cat: '/EL · /RB',
        desc: 'Painel de Proteção e Controle da UG',
      },
      {
        tag: 'CLP-SASE / XED',
        regex: /\b(?:CLP-SASE|SASE|XED\d*|XSD\d*|Cart[ãa]o de Entrada|Supervis[óo]rio)\b/i,
        cat: '/EL · Automação',
        desc: 'Aquisição Digital CLP / SCADA',
      },
      {
        tag: 'QDCC / QDSA (125 Vcc)',
        regex: /\b(?:QDCC|QDSA|QDF|QGBT|CSG[12]?|125\s*Vcc|24\s*Vcc)\b/i,
        cat: '/EL · Auxiliares',
        desc: 'Alimentação de Comando / Serviços Auxiliares',
      },
    ];

    for (const kp of knownPanelOrder) {
      const alreadyInNodes = nodes.some((n) =>
        n.panelOrStage.toUpperCase().includes(kp.tag.split(' ')[0].toUpperCase())
      );
      if (!alreadyInNodes && kp.regex.test(cleanMd) && nodes.length < 5) {
        nodes.push({
          stepNumber: nodes.length + 1,
          panelOrStage: kp.tag,
          categoryTag: kp.cat,
          detailOrTerminals: kp.desc,
          status: nodes.length === 0 ? 'current' : 'verified',
        });
      }
    }

    // 3. Verificar se a Seção 5 sugere um próximo documento/painel externo
    const sec5Match = cleanMd.match(
      /Pr[óo]ximo Desenho na Sequ[êe]ncia[\s\S]*$/i
    );
    if (sec5Match) {
      const docMatch = sec5Match[0].match(
        /\b(\d{8,12}-[A-Z0-9]+|PCPG[12]?|CLP-SASE|QDCC|QDSA|Folha\s+\d+)\b/i
      );
      if (docMatch && nodes.length < 6) {
        nodes.push({
          stepNumber: nodes.length + 1,
          panelOrStage: `Próximo: ${docMatch[1]}`,
          categoryTag: 'Continuidade',
          detailOrTerminals: 'Anexar próximo desenho sugerido',
          status: 'next_target',
        });
      }
    }
  }

  return nodes;
}

export interface InteractiveMeasurementPoint {
  id: string;
  stepLabel: string;
  terminalOrBorne: string;
  referenceCommon: string;
  expectedSpec: string;
  unitHint: string;
  pageNumber: number | null;
}

export type FieldMeasurementValidation =
  | 'pending'
  | 'ok'
  | 'out_of_range';

/**
 * Extrai automaticamente os pontos de medição de bornes a partir do Laudo Técnico
 * para alimentar a Tabela Interativa de Medições de Campo (Checklist de Bornes).
 */
export function extractInteractiveMeasurementsFromMarkdown(
  rawMarkdown: string,
  probeSummary: ProbeSummaryData | null
): InteractiveMeasurementPoint[] {
  if (!rawMarkdown || rawMarkdown.trim().length < 30) return [];

  const points: InteractiveMeasurementPoint[] = [];
  const clean = formatTechnicalSymbols(rawMarkdown)
    .replace(/\*\*/g, '')
    .replace(/`/g, '');

  // 1. Ponto principal vindo do probeSummary
  if (probeSummary) {
    const firstVoltage =
      probeSummary.expectedValue.split('/')[0]?.trim() || '125 Vcc';
    points.push({
      id: 'pt_main_1',
      stepLabel: 'Ponto #1 (Principal)',
      terminalOrBorne: `${probeSummary.terminalStrip} — ${probeSummary.redProbe.slice(0, 48)}`,
      referenceCommon: probeSummary.blackProbe.slice(0, 42),
      expectedSpec: firstVoltage,
      unitHint: firstVoltage.includes('Ω')
        ? 'Ω'
        : firstVoltage.toLowerCase().includes('ma')
          ? 'mA'
          : firstVoltage.toLowerCase().includes('vca')
            ? 'Vca'
            : 'Vcc',
      pageNumber: probeSummary.locationPage,
    });
  }

  // 2. Procurar passos numerados ou linhas de teste com bornes/terminais no texto
  const lines = clean.split('\n');
  let counter = points.length + 1;

  for (const line of lines) {
    if (points.length >= 4) break;
    const trimmed = line.trim();
    if (trimmed.length < 18 || trimmed.length > 260) continue;

    const hasBorneOrContact =
      /\b(?:borne|terminal|régua|[1-9]X[0-9A-Z]{1,3}|XED\d*|XSD\d*|13-14|21-22|A1-A2|95-96|52G[12]?|86[A-Z0-9]*)\b/i.test(
        trimmed
      );
    const voltMatch = trimmed.match(
      /\b(\d{1,3}(?:[.,]\d+)?\s*(?:Vcc|Vca|Vac|Vdc|mA|Ω|kΩ)|menor que \d+\s*Ω|0\s*Vcc)\b/i
    );

    if (hasBorneOrContact && voltMatch) {
      const borneTokenMatch = trimmed.match(
        /\b([1-9]X[0-9A-Z]{1,3}(?:[:\-/]\d+)?|XED\d*(?:[:\-/]\d+)?|XSD\d*(?:[:\-/]\d+)?|Borne\s+[A-Z0-9:.\-/]+|13-14|21-22|A1-A2|95-96)\b/i
      );
      const terminalCandidate = borneTokenMatch
        ? borneTokenMatch[1]
        : trimmed.slice(0, 42);

      const alreadyAdded = points.some((p) =>
        p.terminalOrBorne
          .toLowerCase()
          .includes(terminalCandidate.toLowerCase())
      );
      if (alreadyAdded) continue;

      const explicitPgMatch = trimmed.match(
        /\b(?:P[áa]gina|P[áa]g\.?)\s*(?:do\s+PDF\s*)?#?\s*(\d{1,3})\b/i
      );
      const explicitFlMatch = trimmed.match(
        /\b(?:Folha(?:\s+Selo)?(?:\s+FL\.?)?|Fl\.?)\s*#?\s*(\d{1,3})\b/i
      );
      let resolvedPointPage: number | null = probeSummary?.locationPage || null;
      if (explicitPgMatch) {
        resolvedPointPage = parseInt(explicitPgMatch[1], 10);
      } else if (explicitFlMatch) {
        resolvedPointPage = resolveCitationToPdfPage(
          parseInt(explicitFlMatch[1], 10),
          true,
          rawMarkdown
        ).pdfPage;
      }

      const spec = voltMatch[1].trim();

      points.push({
        id: `pt_auto_${counter}`,
        stepLabel: `Ponto #${counter}`,
        terminalOrBorne: `${terminalCandidate} (${trimmed
          .replace(/^[-*0-9.)\s]+/, '')
          .slice(0, 44)}...)`,
        referenceCommon: probeSummary?.blackProbe.slice(0, 36) || '0Vcc / Comum',
        expectedSpec: spec,
        unitHint: spec.includes('Ω')
          ? 'Ω'
          : spec.toLowerCase().includes('ma')
            ? 'mA'
            : spec.toLowerCase().includes('vca')
              ? 'Vca'
              : 'Vcc',
        pageNumber: resolvedPointPage,
      });
      counter++;
    }
  }

  // 3. Se só extraiu 1 ponto, adicionar pontos complementares típicos da cadeia (Entrada/Saída do Contato e Bobina/CLP)
  if (points.length === 1 && probeSummary) {
    points.push({
      id: 'pt_contact_out',
      stepLabel: 'Ponto #2 (Jusante)',
      terminalOrBorne: `Saída do Contato (${probeSummary.contactsOrComponent.split('·')[0]?.trim() || '14 / 22'})`,
      referenceCommon: probeSummary.blackProbe.slice(0, 36),
      expectedSpec: probeSummary.expectedValue.split('/')[0]?.trim() || '125 Vcc',
      unitHint: 'Vcc',
      pageNumber: probeSummary.locationPage,
    });
    points.push({
      id: 'pt_coil_clp',
      stepLabel: 'Ponto #3 (Bobina / CLP)',
      terminalOrBorne: `Entrada CLP / Bobina A1-A2 (${probeSummary.terminalStrip.split('·')[0]?.trim() || 'XED'})`,
      referenceCommon: 'A2 / 0Vcc Comum',
      expectedSpec: probeSummary.expectedValue.includes('24')
        ? '24 Vcc'
        : probeSummary.expectedValue.split('/')[0]?.trim() || '125 Vcc',
      unitHint: 'Vcc',
      pageNumber: probeSummary.locationPage,
    });
  }

  return points;
}

/**
 * Avalia automaticamente se o valor medido no multímetro está dentro da faixa esperada (±15% para tensão,
 * 4-20 mA para corrente ou limiar de continuidade em Ohms).
 */
export function evaluateFieldMeasurementStatus(
  expectedSpec: string,
  measuredRaw: string
): {
  status: FieldMeasurementValidation;
  reason: string;
} {
  const cleanMeasured = (measuredRaw || '').trim().replace(',', '.');
  if (!cleanMeasured) {
    return { status: 'pending', reason: 'Aguardando leitura' };
  }

  const numMatch = cleanMeasured.match(/-?\d+(?:\.\d+)?/);
  if (!numMatch) {
    if (/^(ok|normal|fechado|atuado)$/i.test(cleanMeasured)) {
      return { status: 'ok', reason: 'Confirmado manualmente' };
    }
    if (/^(falha|aberto|zero|curto|desarmado)$/i.test(cleanMeasured)) {
      return { status: 'out_of_range', reason: 'Anomalia informada' };
    }
    return { status: 'pending', reason: 'Digite o valor numérico' };
  }

  const measuredVal = parseFloat(numMatch[0]);
  const cleanExpected = (expectedSpec || '').replace(',', '.');

  // Caso 1: Continuidade / Resistência (ex: "menor que 2 Ω", "< 2 Ω", "0 Ω")
  if (cleanExpected.includes('Ω') || /ohm/i.test(cleanExpected)) {
    const maxOhmMatch = cleanExpected.match(/(\d+(?:\.\d+)?)/);
    const maxAllowed = maxOhmMatch ? parseFloat(maxOhmMatch[1]) : 5;
    if (measuredVal <= Math.max(maxAllowed * 1.5, 2.5)) {
      return {
        status: 'ok',
        reason: `Continuidade OK (${measuredVal} Ω)`,
      };
    }
    return {
      status: 'out_of_range',
      reason: `Circuito aberto / Alta resistência (${measuredVal} Ω > ${maxAllowed} Ω)`,
    };
  }

  // Caso 2: Corrente 4-20 mA
  if (/4\s*[-aà]\s*20\s*ma/i.test(cleanExpected) || /ma\b/i.test(cleanExpected)) {
    if (measuredVal >= 3.8 && measuredVal <= 20.5) {
      return {
        status: 'ok',
        reason: `Loop 4–20 mA íntegro (${measuredVal} mA)`,
      };
    }
    return {
      status: 'out_of_range',
      reason:
        measuredVal < 3.8
          ? `Loop aberto / Fio rompido (${measuredVal} mA < 4 mA)`
          : `Saturação de corrente (${measuredVal} mA > 20 mA)`,
    };
  }

  // Caso 3: Tensão (125 Vcc, 24 Vcc, 220 Vca, 0 Vcc, etc.)
  const expVoltMatch = cleanExpected.match(/(\d+(?:\.\d+)?)/);
  if (expVoltMatch) {
    const targetVolt = parseFloat(expVoltMatch[1]);
    if (targetVolt === 0) {
      if (Math.abs(measuredVal) <= 2.0) {
        return { status: 'ok', reason: `0 V confirmado (${measuredVal} V)` };
      }
      return {
        status: 'out_of_range',
        reason: `Tensão residual indevida (${measuredVal} V != 0 V)`,
      };
    }

    const minAllowed = targetVolt * 0.85; // -15%
    const maxAllowed = targetVolt * 1.15; // +15%
    if (measuredVal >= minAllowed && measuredVal <= maxAllowed) {
      return {
        status: 'ok',
        reason: `Dentro da faixa nominal (${measuredVal} V ≈ ${targetVolt} V ±15%)`,
      };
    }
    if (measuredVal < 3.0) {
      return {
        status: 'out_of_range',
        reason: `Ausência de tensão / Circuito aberto (${measuredVal} V vs ${targetVolt} V)`,
      };
    }
    return {
      status: 'out_of_range',
      reason: `Fora da tolerância (${measuredVal} V vs esperado ${targetVolt} V)`,
    };
  }

  return {
    status: measuredVal > 0 ? 'ok' : 'out_of_range',
    reason: measuredVal > 0 ? `Leitura registrada (${measuredVal})` : 'Valor zerado (0)',
  };
}





