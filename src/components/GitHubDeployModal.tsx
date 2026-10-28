import React, { useState, useEffect } from 'react';
import {
  GitBranch,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Lock,
  Globe,
  Terminal,
  UploadCloud,
  CloudLightning,
  KeyRound,
  Download,
  FileCode,
  Archive,
  FolderArchive,
  FileText,
  Eye,
  Database,
  RefreshCw,
} from 'lucide-react';

interface BackupFileEntry {
  path: string;
  sizeBytes: number;
  content: string;
}

interface SourceBundleResponse {
  generatedAt: string;
  projectName: string;
  totalFiles: number;
  totalBytes: number;
  files: BackupFileEntry[];
}

interface SupabaseStatusInfo {
  configured: boolean;
  connected: boolean;
  tableReady: boolean;
  projectName: string;
  tableName: string;
  count?: number;
  message: string;
}

export const SUPABASE_SQL_SCHEMA = `-- ============================================================================
-- HYDRODIAG AI — TABELA ISOLADA PARA O PROJETO SUPABASE: "Agenda Financeira youware"
-- ============================================================================
-- Cole este código no menu "SQL Editor" do projeto "Agenda Financeira youware" e clique em "Run".
-- Esta tabela é 100% isolada e NÃO interfere nas tabelas da sua Agenda Financeira.

CREATE TABLE IF NOT EXISTS public.hydrodiag_investigations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'em_investigacao',
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  field_resolution_note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attachment_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,
  turns JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_hydrodiag_investigations_updated_at
  ON public.hydrodiag_investigations (updated_at DESC);

ALTER TABLE public.hydrodiag_investigations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow full access to hydrodiag_investigations" ON public.hydrodiag_investigations;

CREATE POLICY "Allow full access to hydrodiag_investigations"
  ON public.hydrodiag_investigations
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);`;

const VERCEL_JSON_CONTENT = `{
  "version": 2,
  "installCommand": "npm install --legacy-peer-deps",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "functions": {
    "api/index.ts": {
      "maxDuration": 60,
      "memory": 1024
    }
  },
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "/api/index.ts"
    },
    {
      "source": "/((?!api/).*)",
      "destination": "/index.html"
    }
  ]
}
`;

const API_INDEX_TS_CONTENT = `import { createApiApp } from '../server';

const app = createApiApp();

export default app;
`;

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const GitHubDeployPanel: React.FC = () => {
  const [githubUsername, setGithubUsername] = useState('marcondi');
  const [repoName, setRepoName] = useState('hydrodiag-ai-pch-uhe');
  const [githubToken, setGithubToken] = useState(() => {
    try {
      return localStorage.getItem('hydrodiag_github_pat') || '';
    } catch {
      return '';
    }
  });
  const [isPrivate, setIsPrivate] = useState(false);

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    repoUrl: string;
    uploadedCount: number;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedEnvKey, setCopiedEnvKey] = useState(false);
  const [copiedVercelJson, setCopiedVercelJson] = useState(false);
  const [copiedApiIndex, setCopiedApiIndex] = useState(false);
  const [copiedSupabaseSql, setCopiedSupabaseSql] = useState(false);

  // Supabase status state
  const [supabaseStatus, setSupabaseStatus] =
    useState<SupabaseStatusInfo | null>(null);
  const [isCheckingSupabase, setIsCheckingSupabase] = useState(false);

  // Backup state
  const [backupBundle, setBackupBundle] = useState<SourceBundleResponse | null>(
    null
  );
  const [isLoadingBundle, setIsLoadingBundle] = useState(false);
  const [selectedFilePreview, setSelectedFilePreview] =
    useState<BackupFileEntry | null>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);

  const safeFetchJson = async <T,>(
    url: string,
    init?: RequestInit
  ): Promise<{ ok: boolean; status: number; data: T | null; isHtml: boolean; rawText: string }> => {
    const res = await fetch(url, init);
    const rawText = await res.text();
    const trimmed = rawText.trim();
    const isHtml =
      trimmed.toLowerCase().startsWith('<!doctype') ||
      trimmed.toLowerCase().startsWith('<html') ||
      trimmed.startsWith('<');
    if (isHtml) {
      return { ok: false, status: res.status, data: null, isHtml: true, rawText };
    }
    try {
      const parsed = JSON.parse(trimmed) as T;
      return { ok: res.ok, status: res.status, data: parsed, isHtml: false, rawText };
    } catch {
      return { ok: false, status: res.status, data: null, isHtml: false, rawText };
    }
  };

  const fetchSourceBundleWithFallback = async (): Promise<SourceBundleResponse | null> => {
    const bust = Date.now();
    try {
      const apiRes = await safeFetchJson<SourceBundleResponse>(
        `/api/backup/source-bundle?t=${bust}`
      );
      if (apiRes.ok && apiRes.data && Array.isArray(apiRes.data.files) && apiRes.data.files.length >= 10) {
        return apiRes.data;
      }
    } catch {
      // Fallback to static bundle in public/
    }

    try {
      const staticRes = await safeFetchJson<SourceBundleResponse>(
        `/hydrodiag-source-bundle.json?t=${bust}`
      );
      if (staticRes.ok && staticRes.data && Array.isArray(staticRes.data.files) && staticRes.data.files.length > 0) {
        return staticRes.data;
      }
    } catch {
      // Ignore
    }

    return null;
  };

  const checkSupabaseConnection = async () => {
    setIsCheckingSupabase(true);
    try {
      const res = await safeFetchJson<SupabaseStatusInfo>('/api/supabase/status');
      if (res.ok && res.data) {
        setSupabaseStatus(res.data);
      }
    } catch {
      // Ignore
    } finally {
      setIsCheckingSupabase(false);
    }
  };

  useEffect(() => {
    let active = true;
    setIsLoadingBundle(true);
    fetchSourceBundleWithFallback()
      .then((data) => {
        if (active && data && Array.isArray(data.files)) {
          setBackupBundle(data);
        }
      })
      .finally(() => {
        if (active) setIsLoadingBundle(false);
      });

    checkSupabaseConnection();

    return () => {
      active = false;
    };
  }, []);

  const handleCopySupabaseSql = async () => {
    try {
      await navigator.clipboard.writeText(SUPABASE_SQL_SCHEMA);
      setCopiedSupabaseSql(true);
      setTimeout(() => setCopiedSupabaseSql(false), 2500);
    } catch {
      // Ignore
    }
  };

  const handleDownloadUnifiedTextBackup = () => {
    if (!backupBundle) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
      '================================================================================',
      'HYDRODIAG AI — BACKUP COMPLETO DO CÓDIGO-FONTE (UNIFICADO)',
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      `Total de Arquivos: ${backupBundle.totalFiles} | Tamanho Total: ${formatSize(backupBundle.totalBytes)}`,
      '================================================================================',
      '',
    ];

    for (const file of backupBundle.files) {
      lines.push(
        `// ============================================================================`,
        `// ARQUIVO: ${file.path} (${formatSize(file.sizeBytes)})`,
        `// ============================================================================`,
        file.content,
        '',
        ''
      );
    }

    downloadTextFile(
      `hydrodiag-ai-codigo-completo-${dateStr}.txt`,
      lines.join('\n')
    );
  };

  const handleDownloadJsonFullBackup = () => {
    if (!backupBundle) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    let localInvestigations: unknown = [];
    try {
      const raw =
        localStorage.getItem('hydrodiag_saved_investigations_v2') ||
        localStorage.getItem('hydrodiag_saved_investigations_v1');
      if (raw) localInvestigations = JSON.parse(raw);
    } catch {
      // Ignore
    }

    const fullPayload = {
      ...backupBundle,
      savedInvestigationsLocalStorage: localInvestigations,
    };

    downloadTextFile(
      `hydrodiag-ai-backup-sistema-completo-${dateStr}.json`,
      JSON.stringify(fullPayload, null, 2)
    );
  };

  const handleTokenChange = (val: string) => {
    setGithubToken(val);
    try {
      localStorage.setItem('hydrodiag_github_pat', val.trim());
    } catch {
      // Ignore storage error
    }
  };

  const publishDirectlyFromBrowserToGitHub = async (params: {
    owner: string;
    cleanRepo: string;
    token: string;
    isPrivate: boolean;
    files: BackupFileEntry[];
  }): Promise<{ repoUrl: string; uploadedCount: number }> => {
    const { owner, cleanRepo, token, isPrivate: priv, files } = params;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
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
          private: Boolean(priv),
          auto_init: true,
        }),
      });
      if (!createRes.ok) {
        const errBody = await createRes.text();
        throw new Error(
          `Não foi possível criar o repositório no GitHub: ${errBody.slice(0, 180)}`
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    } else if (!checkRes.ok) {
      const errBody = await checkRes.text();
      throw new Error(
        `Falha ao autenticar no GitHub (${checkRes.status}): verifique se o seu Token (PAT) possui a permissão 'repo'. Detalhe: ${errBody.slice(0, 140)}`
      );
    }

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
    if (!refRes.ok) {
      throw new Error(`Não foi possível localizar a branch ${branch} no GitHub.`);
    }
    const refData = (await refRes.json()) as { object?: { sha?: string } };
    const latestCommitSha = refData.object?.sha;
    if (!latestCommitSha) {
      throw new Error('SHA do commit atual não encontrado no repositório.');
    }

    const commitRes = await fetch(
      `https://api.github.com/repos/${owner}/${cleanRepo}/git/commits/${latestCommitSha}`,
      { headers }
    );
    const commitData = commitRes.ok
      ? ((await commitRes.json()) as { tree?: { sha?: string } })
      : {};
    const baseTreeSha = commitData.tree?.sha;

    const treeItems = files.map((f) => ({
      path: f.path,
      mode: '100644' as const,
      type: 'blob' as const,
      content: f.content,
    }));

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
    if (!createTreeRes.ok) {
      const errText = await createTreeRes.text();
      throw new Error(`Falha ao montar árvore Git: ${errText.slice(0, 160)}`);
    }
    const treeData = (await createTreeRes.json()) as { sha?: string };
    const newTreeSha = treeData.sha;

    if (newTreeSha && newTreeSha !== baseTreeSha) {
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
            message: `feat(release): HydroDiag AI — PWA + Voz + Tabela de Campo + PDF Deep-Link (${stamp})`,
            tree: newTreeSha,
            parents: [latestCommitSha],
          }),
        }
      );
      if (!newCommitRes.ok) {
        const errText = await newCommitRes.text();
        throw new Error(`Falha ao criar commit no GitHub: ${errText.slice(0, 160)}`);
      }
      const newCommitData = (await newCommitRes.json()) as { sha?: string };
      if (newCommitData.sha) {
        const updateRefRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepo}/git/refs/heads/${branch}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ sha: newCommitData.sha, force: true }),
          }
        );
        if (!updateRefRes.ok) {
          const errText = await updateRefRes.text();
          throw new Error(`Falha ao atualizar branch ${branch}: ${errText.slice(0, 160)}`);
        }
      }
    }

    return {
      repoUrl: `https://github.com/${owner}/${cleanRepo}`,
      uploadedCount: treeItems.length,
    };
  };

  const handlePublishToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubToken.trim()) return;

    const cleanOwner = githubUsername.trim() || 'marcondi';
    const cleanRepo =
      repoName.trim().replace(/[^a-zA-Z0-9._-]/g, '-') ||
      'hydrodiag-ai-pch-uhe';
    const cleanToken = githubToken.trim();

    try {
      localStorage.setItem('hydrodiag_github_pat', cleanToken);
    } catch {
      // Ignore
    }

    setIsPublishing(true);
    setPublishError(null);
    setPublishResult(null);

    try {
      const freshBundle = await fetchSourceBundleWithFallback();
      const currentBundle = freshBundle || backupBundle;
      if (freshBundle) {
        setBackupBundle(freshBundle);
      }

      const apiRes = await safeFetchJson<{
        repoUrl?: string;
        uploadedCount?: number;
        error?: string;
      }>('/api/github/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubUsername: cleanOwner,
          repoName: cleanRepo,
          githubToken: cleanToken,
          isPrivate,
          clientFiles: currentBundle?.files || [],
        }),
      });

      if (apiRes.ok && apiRes.data && apiRes.data.repoUrl) {
        setPublishResult({
          repoUrl: apiRes.data.repoUrl,
          uploadedCount: apiRes.data.uploadedCount || currentBundle?.files.length || 28,
        });
        return;
      }

      // If the server returned an HTML fallback ("<!doctype html>...") or 404/500 on Vercel,
      // fallback seamlessly to direct Browser -> GitHub REST API publishing!
      if (
        (apiRes.isHtml || apiRes.status === 404 || apiRes.status === 405 || apiRes.status >= 500) &&
        currentBundle &&
        currentBundle.files.length > 0
      ) {
        const directResult = await publishDirectlyFromBrowserToGitHub({
          owner: cleanOwner,
          cleanRepo,
          token: cleanToken,
          isPrivate,
          files: currentBundle.files,
        });
        setPublishResult(directResult);
        return;
      }

      throw new Error(
        apiRes.data?.error ||
          'Não foi possível sincronizar no GitHub. Verifique se o Token possui permissão "repo".'
      );
    } catch (err) {
      setPublishError(
        err instanceof Error
          ? err.message
          : 'Erro ao conectar com a API do GitHub.'
      );
    } finally {
      setIsPublishing(false);
    }
  };

  const gitCommands = `git add .
git commit -m "feat: suporte completo a Vercel Serverless + Supabase (Agenda Financeira youware)"
git branch -M main
git push -u origin main`;

  const handleCopyCommands = async () => {
    try {
      await navigator.clipboard.writeText(gitCommands);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyEnvName = async () => {
    try {
      await navigator.clipboard.writeText('GEMINI_API_KEY');
      setCopiedEnvKey(true);
      setTimeout(() => setCopiedEnvKey(false), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-6">
      {/* ==================================================================== */}
      {/* 0. BANCO DE DADOS EM NUVEM SUPABASE ("Agenda Financeira youware")    */}
      {/* ==================================================================== */}
      <div className="bg-[#0B111E] border-2 border-sky-500/40 rounded-lg p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-sky-400" />
              <h2 className="text-base font-bold text-slate-100">
                Banco de Dados em Nuvem Supabase — Projeto:{' '}
                <span className="text-sky-400">Agenda Financeira youware</span>
              </h2>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              O código já está preparado para salvar e sincronizar todos os
              diagnósticos, laudos e conversas do chat técnico na tabela isolada{' '}
              <code>public.hydrodiag_investigations</code> dentro do seu projeto{' '}
              <strong>Agenda Financeira youware</strong> (sem interferir em
              nenhuma tabela existente da sua agenda financeira).
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`px-3 py-1.5 rounded text-xs font-mono border ${
                supabaseStatus?.connected
                  ? 'bg-emerald-950/50 border-emerald-600/50 text-emerald-300'
                  : supabaseStatus?.configured
                    ? 'bg-amber-950/50 border-amber-600/50 text-amber-300'
                    : 'bg-slate-900 border-slate-700 text-slate-300'
              }`}
            >
              {supabaseStatus?.connected
                ? `ONLINE · ${supabaseStatus.count ?? 0} diagnóstico(s) na nuvem`
                : supabaseStatus?.configured
                  ? 'AGUARDANDO TABELA SQL'
                  : 'MODO HÍBRIDO (AGUARDANDO CHAVES NA VERCEL)'}
            </span>
            <button
              type="button"
              onClick={checkSupabaseConnection}
              disabled={isCheckingSupabase}
              className="p-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
              title="Testar conexão com Supabase"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isCheckingSupabase ? 'animate-spin text-sky-400' : ''}`}
              />
            </button>
          </div>
        </div>

        {/* Passo a passo para ativar no Agenda Financeira youware */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-[#111827] border border-slate-800 rounded-md p-4 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400">
              Passo 1: Criar a Tabela no &quot;Agenda Financeira youware&quot;
            </h3>
            <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside leading-relaxed">
              <li>
                No painel do Supabase, clique no seu projeto{' '}
                <strong className="text-white">
                  Agenda Financeira youware
                </strong>
                .
              </li>
              <li>
                No menu lateral esquerdo, clique em{' '}
                <strong className="text-white">SQL Editor</strong> &rarr;{' '}
                <strong className="text-white">+ New query</strong>.
              </li>
              <li>
                Clique em <strong>Copiar Script SQL</strong> ao lado, cole lá e
                aperte o botão verde{' '}
                <strong className="text-emerald-400">Run</strong>.
              </li>
            </ol>

            <div className="pt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCopySupabaseSql}
                className="px-3.5 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs flex items-center gap-2 cursor-pointer transition-colors"
              >
                {copiedSupabaseSql ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-200" />
                    <span>Script SQL Copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>
                      Copiar Script SQL (Tabela hydrodiag_investigations)
                    </span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    'supabase_hydrodiag_schema.sql',
                    SUPABASE_SQL_SCHEMA
                  )
                }
                className="px-3 py-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" />
                <span>Baixar .SQL</span>
              </button>
            </div>
          </div>

          <div className="bg-[#111827] border border-slate-800 rounded-md p-4 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Passo 2: Conectar na Vercel (Para Abrir em Qualquer PC)
            </h3>
            <ol className="text-xs text-slate-300 space-y-2 list-decimal list-inside leading-relaxed">
              <li>
                Dentro do projeto{' '}
                <strong className="text-white">
                  Agenda Financeira youware
                </strong>{' '}
                no Supabase, vá em{' '}
                <strong className="text-white">
                  Project Settings &rarr; API
                </strong>
                .
              </li>
              <li>
                Na <strong>Vercel</strong> (em{' '}
                <em>Settings &rarr; Environment Variables</em>), adicione estas
                2 variáveis junto com a sua <code>GEMINI_API_KEY</code>:
                <ul className="mt-1.5 ml-4 space-y-1 font-mono text-[11px] text-slate-200">
                  <li>
                    • <span className="text-sky-300">SUPABASE_URL</span> ={' '}
                    <span className="text-slate-400">
                      Project URL (ex: https://xxxx.supabase.co)
                    </span>
                  </li>
                  <li>
                    • <span className="text-sky-300">SUPABASE_ANON_KEY</span> ={' '}
                    <span className="text-slate-400">
                      Project API Key (anon / public)
                    </span>
                  </li>
                </ul>
              </li>
              <li>
                Pronto! Qualquer diagnóstico salvo em um PC aparecerá
                automaticamente em todos os outros computadores e celulares.
              </li>
            </ol>
          </div>
        </div>

        {/* Preview do SQL */}
        <details className="bg-[#111827] border border-slate-800 rounded-md">
          <summary className="px-4 py-2.5 text-xs font-mono text-slate-300 cursor-pointer hover:text-white flex items-center justify-between">
            <span>
              Ver código SQL completo da tabela{' '}
              <code>public.hydrodiag_investigations</code>
            </span>
            <span className="text-[11px] text-sky-400">Clique para abrir</span>
          </summary>
          <pre className="p-4 border-t border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto leading-relaxed">
            {SUPABASE_SQL_SCHEMA}
          </pre>
        </details>
      </div>

      {/* ==================================================================== */}
      {/* 1. CENTRAL DE BACKUP COMPLETO DO CÓDIGO-FONTE (DOWNLOAD DIRETO)      */}
      {/* ==================================================================== */}
      <div className="bg-[#0B111E] border-2 border-emerald-500/40 rounded-lg p-5 flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FolderArchive className="w-5 h-5 text-emerald-400" />
              <h2 className="text-base font-bold text-slate-100">
                Backup Completo do Código-Fonte — Guardar Cópia Local (.ZIP)
              </h2>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Baixe agora uma cópia integral de todos os arquivos do sistema (
              <code>server.ts</code>, <code>api/index.ts</code>,{' '}
              <code>supabase_hydrodiag_schema.sql</code>,{' '}
              <code>src/App.tsx</code>, componentes, motor PDF,{' '}
              <code>package.json</code> e <code>vercel.json</code>) pronta para
              guardar no seu computador, rodar localmente ou publicar.
            </p>
          </div>

          {backupBundle && (
            <div className="px-3 py-1.5 rounded bg-emerald-950/50 border border-emerald-700/50 text-xs font-mono text-emerald-300 shrink-0">
              {backupBundle.totalFiles} arquivos ·{' '}
              {formatSize(backupBundle.totalBytes)} verificados
            </div>
          )}
        </div>

        {/* 3 Main Download Buttons */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <a
            href="/api/backup/download-zip"
            download
            className="p-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex flex-col justify-between gap-3 transition-colors shadow-sm cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-wider text-emerald-100">
                RECOMENDADO · PACOTE .ZIP
              </span>
              <Archive className="w-5 h-5 text-white" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-bold flex items-center gap-2">
                <Download className="w-4 h-4 shrink-0" />
                <span>Baixar Backup Completo (.ZIP)</span>
              </div>
              <p className="text-[11px] text-emerald-100/90 font-normal leading-relaxed">
                Contém todas as pastas (<code>src/</code>, <code>api/</code>) e
                arquivos prontos para descompactar e rodar{' '}
                <code>npm install</code>.
              </p>
            </div>
          </a>

          <button
            type="button"
            onClick={handleDownloadUnifiedTextBackup}
            disabled={!backupBundle || isLoadingBundle}
            className="p-4 rounded-lg bg-[#111827] hover:bg-slate-800/90 disabled:opacity-50 border border-sky-500/40 text-left text-xs flex flex-col justify-between gap-3 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <span className="font-mono text-[11px] uppercase tracking-wider text-sky-400">
                ARQUIVO ÚNICO · LEITURA DIRETA
              </span>
              <FileText className="w-5 h-5 text-sky-400" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Download className="w-4 h-4 text-sky-400 shrink-0" />
                <span>Baixar Todo o Código em 1 Arquivo (.TXT)</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Todos os arquivos do projeto concatenados e organizados em um
                único documento de texto para consulta rápida.
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={handleDownloadJsonFullBackup}
            disabled={!backupBundle || isLoadingBundle}
            className="p-4 rounded-lg bg-[#111827] hover:bg-slate-800/90 disabled:opacity-50 border border-amber-500/40 text-left text-xs flex flex-col justify-between gap-3 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between w-full">
              <span className="font-mono text-[11px] uppercase tracking-wider text-amber-400">
                CÓDIGO + HISTÓRICO DE FALHAS
              </span>
              <FileCode className="w-5 h-5 text-amber-400" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Download className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Baixar Snapshot Completo (.JSON)</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Inclui todo o código-fonte + o banco de dados de investigações e
                histórico de falhas salvos.
              </p>
            </div>
          </button>
        </div>

        {/* Interactive File List inside Backup */}
        {backupBundle && (
          <div className="border border-slate-800 rounded-lg overflow-hidden bg-[#111827]">
            <div className="px-4 py-2.5 bg-[#0B111E] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-200">
                Arquivos Incluídos no Backup ({backupBundle.files.length}{' '}
                arquivos do sistema)
              </span>
              <span className="text-[11px] text-slate-400">
                Clique em qualquer arquivo para visualizar, copiar ou baixar
                individualmente
              </span>
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/70 text-xs">
              {backupBundle.files.map((file) => (
                <div
                  key={file.path}
                  className="px-4 py-2 flex items-center justify-between gap-3 hover:bg-slate-900/60 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileCode className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="font-mono text-slate-200 truncate">
                      {file.path}
                    </span>
                    <span className="text-[11px] font-mono text-slate-500 shrink-0">
                      ({formatSize(file.sizeBytes)})
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedFilePreview(
                          selectedFilePreview?.path === file.path ? null : file
                        )
                      }
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Eye className="w-3 h-3" />
                      <span>
                        {selectedFilePreview?.path === file.path
                          ? 'Ocultar'
                          : 'Ver Código'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(file.content);
                        setCopiedFilePath(file.path);
                        setTimeout(() => setCopiedFilePath(null), 2000);
                      }}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 cursor-pointer"
                    >
                      {copiedFilePath === file.path ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-300">Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copiar</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        const baseName =
                          file.path.split('/').pop() || file.path;
                        downloadTextFile(baseName, file.content);
                      }}
                      className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      <span>Baixar</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {selectedFilePreview && (
              <div className="border-t border-slate-800 bg-[#0B111E] p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-semibold text-sky-400">
                    Visualizando: {selectedFilePreview.path}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedFilePreview(null)}
                    className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    Fechar visualização
                  </button>
                </div>
                <pre className="max-h-80 overflow-auto p-3 rounded bg-[#111827] border border-slate-800 text-[11px] font-mono text-slate-200">
                  <code>{selectedFilePreview.content}</code>
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <CloudLightning className="w-4 h-4 text-sky-400" />
            <span>
              Publicação na Vercel & Sincronização GitHub (@marcondi)
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Baixe ou copie abaixo os arquivos <code>vercel.json</code> e{' '}
            <code>api/index.ts</code> (ou sincronize com 1 clique direto na sua
            conta GitHub).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href="https://github.com/marcondi"
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors"
          >
            <GitBranch className="w-3.5 h-3.5 text-slate-300" />
            <span>GitHub @marcondi</span>
            <ExternalLink className="w-3 h-3 text-sky-400" />
          </a>

          <a
            href="https://vercel.com/new"
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded-md flex items-center gap-1.5 transition-colors"
          >
            <CloudLightning className="w-3.5 h-3.5" />
            <span>Abrir Painel da Vercel (Importar Projeto)</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* DIRECT DOWNLOAD & COPY OF VERCEL.JSON AND API/INDEX.TS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* File 1: vercel.json */}
        <div className="bg-[#0B111E] border border-sky-500/30 rounded-lg p-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-sky-400" />
              <span className="text-sm font-mono font-semibold text-slate-100">
                vercel.json
              </span>
              <span className="text-xs text-slate-400">
                (Colocar na raiz do projeto)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(VERCEL_JSON_CONTENT);
                  setCopiedVercelJson(true);
                  setTimeout(() => setCopiedVercelJson(false), 2000);
                }}
                className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1.5 cursor-pointer"
              >
                {copiedVercelJson ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar Código</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() =>
                  downloadTextFile('vercel.json', VERCEL_JSON_CONTENT)
                }
                className="px-2.5 py-1 text-xs font-medium text-white bg-sky-600 hover:bg-sky-500 rounded flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Baixar vercel.json</span>
              </button>
            </div>
          </div>

          <pre className="bg-[#111827] border border-slate-800 rounded-md p-3.5 text-xs font-mono text-sky-300 overflow-x-auto">
            <code>{VERCEL_JSON_CONTENT}</code>
          </pre>
        </div>

        {/* File 2: api/index.ts */}
        <div className="bg-[#0B111E] border border-sky-500/30 rounded-lg p-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-mono font-semibold text-slate-100">
                api/index.ts
              </span>
              <span className="text-xs text-slate-400">
                (Criar pasta <code>api</code> e colocar dentro)
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(API_INDEX_TS_CONTENT);
                  setCopiedApiIndex(true);
                  setTimeout(() => setCopiedApiIndex(false), 2000);
                }}
                className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1.5 cursor-pointer"
              >
                {copiedApiIndex ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar Código</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() =>
                  downloadTextFile('index.ts', API_INDEX_TS_CONTENT)
                }
                className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Baixar index.ts</span>
              </button>
            </div>
          </div>

          <pre className="bg-[#111827] border border-slate-800 rounded-md p-3.5 text-xs font-mono text-emerald-300 overflow-x-auto flex-1">
            <code>{API_INDEX_TS_CONTENT}</code>
          </pre>
        </div>
      </div>

      {/* VERCEL STEP-BY-STEP DEPLOY GUIDE */}
      <div className="bg-[#0B111E] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <CloudLightning className="w-4 h-4 text-sky-400" />
            <span>
              Como Publicar na Vercel em 3 Passos (Acessar de Qualquer PC)
            </span>
          </h3>
          <span className="text-xs font-mono text-emerald-400">
            Arquitetura Serverless Pronta (vercel.json + api/index.ts)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Step 1 */}
          <div className="p-4 rounded-lg bg-[#111827] border border-slate-800 flex flex-col gap-2">
            <span className="text-xs font-mono font-semibold text-sky-400">
              PASSO 1 · ATUALIZAR O GITHUB
            </span>
            <p className="text-xs font-semibold text-slate-100">
              Envie os arquivos da Vercel para o seu repositório
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              Use o botão de <strong>Sincronizar com 1 Clique</strong> abaixo ou
              baixe o ZIP atualizado do projeto no ícone de download do AI Studio
              (ele já inclui <code>vercel.json</code> e <code>api/index.ts</code>
              ).
            </p>
          </div>

          {/* Step 2 */}
          <div className="p-4 rounded-lg bg-[#111827] border border-slate-800 flex flex-col gap-2">
            <span className="text-xs font-mono font-semibold text-amber-400">
              PASSO 2 · IMPORTAR NA VERCEL
            </span>
            <p className="text-xs font-semibold text-slate-100">
              Conecte o repositório do GitHub na Vercel
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              Acesse{' '}
              <a
                href="https://vercel.com/new"
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:underline font-mono"
              >
                vercel.com/new
              </a>
              , faça login com sua conta GitHub (<code>marcondi</code>) e clique
              em <strong>Import</strong> ao lado do repositório do{' '}
              <strong>HydroDiag AI</strong>.
            </p>
          </div>

          {/* Step 3 */}
          <div className="p-4 rounded-lg bg-[#111827] border border-slate-800 flex flex-col gap-2">
            <span className="text-xs font-mono font-semibold text-emerald-400">
              PASSO 3 · VARIÁVEL GEMINI_API_KEY
            </span>
            <p className="text-xs font-semibold text-slate-100">
              Adicione sua chave Gemini na tela de Deploy da Vercel
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              Antes de clicar em <strong>Deploy</strong> (ou em{' '}
              <em>Settings → Environment Variables</em>), adicione a variável:
            </p>
            <div className="mt-1 flex items-center justify-between bg-[#0B111E] border border-slate-700 rounded px-2.5 py-1.5">
              <code className="text-xs font-mono text-sky-300">
                GEMINI_API_KEY
              </code>
              <button
                type="button"
                onClick={handleCopyEnvName}
                className="text-[11px] text-slate-300 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                {copiedEnvKey ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copiar Nome</span>
                  </>
                )}
              </button>
            </div>
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="mt-1 text-[11px] text-sky-400 hover:underline flex items-center gap-1"
            >
              <KeyRound className="w-3 h-3" />
              <span>Pegar minha chave gratuita em aistudio.google.com/apikey</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Option 1: Direct 1-Click API Publisher */}
        <form
          onSubmit={handlePublishToGitHub}
          className="bg-[#0B111E] border border-slate-800 rounded-lg p-5 flex flex-col gap-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <UploadCloud className="w-4 h-4 text-sky-400" />
              <span>
                Enviar Todos os Arquivos Automaticamente para o GitHub (1 Clique)
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Envia <code>vercel.json</code>, <code>api/index.ts</code>,{' '}
              <code>server.ts</code>, <code>package.json</code> e todos os
              componentes direto para o seu repositório em{' '}
              <code>github.com/{githubUsername || 'marcondi'}</code>.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">
                Usuário do GitHub
              </label>
              <input
                type="text"
                value={githubUsername}
                onChange={(e) => setGithubUsername(e.target.value)}
                className="bg-[#111827] border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-300">
                Nome do Repositório (o mesmo que você criou)
              </label>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                className="bg-[#111827] border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">
                GitHub Personal Access Token (escopo <code>repo</code>)
              </label>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=HydroDiag_AI_Vercel"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-sky-400 hover:underline flex items-center gap-1"
              >
                <span>Gerar Token em 1 clique</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <input
              type="password"
              value={githubToken}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="bg-[#111827] border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsPrivate(false)}
              className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 border cursor-pointer ${
                !isPrivate
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                  : 'bg-[#111827] border-slate-800 text-slate-400'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Repositório Público</span>
            </button>
            <button
              type="button"
              onClick={() => setIsPrivate(true)}
              className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 border cursor-pointer ${
                isPrivate
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                  : 'bg-[#111827] border-slate-800 text-slate-400'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Repositório Privado</span>
            </button>
          </div>

          {publishError && (
            <div className="p-3 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-200">
              {publishError}
            </div>
          )}

          {publishResult && (
            <div className="p-3.5 rounded bg-emerald-950/40 border border-emerald-700/60 text-xs text-emerald-200 flex flex-col gap-2">
              <div className="flex items-center gap-2 font-semibold text-emerald-100">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>
                  Repositório atualizado para a Vercel ({publishResult.uploadedCount}{' '}
                  arquivos sincronizados)!
                </span>
              </div>
              <a
                href={publishResult.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sky-300 hover:underline font-mono flex items-center gap-1"
              >
                <span>{publishResult.repoUrl}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}

          <button
            type="submit"
            disabled={isPublishing || !githubToken.trim()}
            className="mt-auto py-2.5 px-4 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <GitBranch className="w-4 h-4" />
            <span>
              {isPublishing
                ? 'Sincronizando Arquivos da Vercel no GitHub...'
                : `Sincronizar Arquivos da Vercel em github.com/${githubUsername || 'marcondi'}/${repoName || 'hydrodiag-ai-pch-uhe'}`}
            </span>
          </button>
        </form>

        {/* Option 2: Native AI Studio Sync & Git CLI Commands */}
        <div className="bg-[#0B111E] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              <span>
                Alternativa: Atualizar pelo Botão GitHub do AI Studio ou Git Local
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Se você subiu o código usando o botão nativo do Google AI Studio ou
              pelo terminal do seu PC:
            </p>
          </div>

          <div className="space-y-2 text-xs text-slate-300">
            <p>
              <strong>1. Pelo Topo do AI Studio:</strong> Clique novamente no
              ícone do <strong>GitHub</strong> (ou <strong>Download App</strong>)
              no canto superior direito da tela do AI Studio — os arquivos{' '}
              <code>vercel.json</code> e <code>api/index.ts</code> já estão na
              árvore de arquivos do projeto!
            </p>
            <p>
              <strong>2. Via Terminal Git Local:</strong>
            </p>
          </div>

          <div className="relative">
            <pre className="bg-[#111827] border border-slate-800 rounded-md p-3.5 text-xs font-mono text-sky-300 overflow-x-auto">
              <code>{gitCommands}</code>
            </pre>
            <button
              type="button"
              onClick={handleCopyCommands}
              className="absolute top-2.5 right-2.5 px-2.5 py-1 text-[11px] font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded flex items-center gap-1 cursor-pointer"
            >
              {copiedCmd ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span>Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copiar</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
