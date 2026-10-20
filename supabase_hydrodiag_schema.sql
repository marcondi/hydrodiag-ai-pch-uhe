-- ============================================================================
-- HYDRODIAG AI — TABELA ISOLADA PARA O PROJETO SUPABASE: "Agenda Financeira youware"
-- ============================================================================
-- INSTRUÇÕES:
-- 1. Abra seu projeto "Agenda Financeira youware" no painel do Supabase.
-- 2. No menu lateral esquerdo, clique em "SQL Editor" -> "+ New query".
-- 3. Cole todo este script abaixo e clique no botão verde "Run" (ou Ctrl+Enter).
--
-- NOTA DE SEGURANÇA:
-- Esta tabela usa o prefixo exclusivo "hydrodiag_investigations" e NÃO altera,
-- NÃO lê e NÃO interfere em nenhuma tabela existente da sua Agenda Financeira.
-- ============================================================================

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

-- Índice para busca e ordenação rápida dos diagnósticos mais recentes
CREATE INDEX IF NOT EXISTS idx_hydrodiag_investigations_updated_at
  ON public.hydrodiag_investigations (updated_at DESC);

-- Habilita Row Level Security (RLS) com política de leitura/gravação para a API do App
ALTER TABLE public.hydrodiag_investigations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow full access to hydrodiag_investigations" ON public.hydrodiag_investigations;

CREATE POLICY "Allow full access to hydrodiag_investigations"
  ON public.hydrodiag_investigations
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);
