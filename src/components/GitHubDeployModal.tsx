import React, { useState } from 'react';
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
} from 'lucide-react';

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

  const handleTokenChange = (val: string) => {
    setGithubToken(val);
    try {
      localStorage.setItem('hydrodiag_github_pat', val.trim());
    } catch {
      // Ignore storage error
    }
  };

  const handlePublishToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubToken.trim()) return;

    try {
      localStorage.setItem('hydrodiag_github_pat', githubToken.trim());
    } catch {
      // Ignore
    }

    setIsPublishing(true);
    setPublishError(null);
    setPublishResult(null);

    try {
      const res = await fetch('/api/github/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubUsername: githubUsername.trim() || 'marcondi',
          repoName: repoName.trim() || 'hydrodiag-ai-pch-uhe',
          githubToken: githubToken.trim(),
          isPrivate,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao publicar no GitHub.');
      }

      setPublishResult({
        repoUrl: data.repoUrl,
        uploadedCount: data.uploadedCount,
      });
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
git commit -m "feat: suporte completo a Vercel Serverless (vercel.json + api/index.ts)"
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
