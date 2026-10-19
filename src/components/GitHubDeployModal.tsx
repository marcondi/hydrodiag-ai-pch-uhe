import React, { useState } from 'react';
import {
  Github,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Lock,
  Globe,
  Terminal,
  UploadCloud,
} from 'lucide-react';

export const GitHubDeployPanel: React.FC = () => {
  const [githubUsername, setGithubUsername] = useState('marcondi');
  const [repoName, setRepoName] = useState('hydrodiag-ai-pch-uhe');
  const [githubToken, setGithubToken] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    repoUrl: string;
    uploadedCount: number;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const handlePublishToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubToken.trim()) return;

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
      setGithubToken('');
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

  const gitCommands = `git init
git add .
git commit -m "feat: HydroDiag AI - Sistema de Diagnóstico Eletromecânico PCH/UHE"
git branch -M main
git remote add origin https://github.com/${githubUsername || 'marcondi'}/${repoName || 'hydrodiag-ai-pch-uhe'}.git
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

  return (
    <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Github className="w-4 h-4 text-sky-400" />
            <span>
              Hospedagem e Publicação Direta no GitHub (@marcondi)
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Envie todo o código-fonte do projeto HydroDiag AI diretamente para a
            sua conta{' '}
            <a
              href="https://github.com/marcondi"
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline font-mono"
            >
              https://github.com/marcondi
            </a>
          </p>
        </div>

        <a
          href="https://github.com/marcondi"
          target="_blank"
          rel="noreferrer"
          className="px-3.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md flex items-center gap-1.5 transition-colors"
        >
          <span>Abrir Perfil @marcondi</span>
          <ExternalLink className="w-3.5 h-3.5 text-sky-400" />
        </a>
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
              <span>Opção 1: Publicação Direta com 1 Clique (Via API)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Cria o repositório automaticamente na sua conta{' '}
              <code>@marcondi</code> e envia todos os arquivos do projeto +{' '}
              <code>README.md</code> profissional.
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
                Nome do Repositório
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
                GitHub Personal Access Token (Classic com escopo{' '}
                <code>repo</code>)
              </label>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=HydroDiag_AI_Deploy"
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
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="bg-[#111827] border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
            <span className="text-[11px] text-slate-500">
              O token é usado apenas nesta requisição para criar o repositório e
              não fica armazenado.
            </span>
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
                  Projeto publicado com sucesso ({publishResult.uploadedCount}{' '}
                  arquivos enviados)!
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
            <Github className="w-4 h-4" />
            <span>
              {isPublishing
                ? 'Criando Repositório e Enviando Arquivos...'
                : `Publicar Agora em github.com/${githubUsername || 'marcondi'}/${repoName || 'hydrodiag-ai-pch-uhe'}`}
            </span>
          </button>
        </form>

        {/* Option 2: Native AI Studio Sync & Git CLI Commands */}
        <div className="bg-[#0B111E] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              <span>
                Opção 2: Botão Nativo do AI Studio ou Comandos Git Locais
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Você também pode sincronizar usando o botão <strong>GitHub</strong>{' '}
              na barra superior do Google AI Studio ou via terminal Git:
            </p>
          </div>

          <div className="space-y-2 text-xs text-slate-300">
            <p>
              <strong>1. Pelo Topo do AI Studio:</strong> Clique no ícone do{' '}
              <strong>GitHub</strong> (ou <em>Download ZIP</em>) no canto
              superior direito da janela do AI Studio e conecte sua conta{' '}
              <code>marcondi</code>.
            </p>
            <p>
              <strong>2. Via Terminal Git Local:</strong> Caso baixe o pacote
              ZIP do projeto, execute os comandos abaixo na pasta do projeto:
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
