# ⚡ HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas (PCH / UHE)

Sistema especialista multimodal desenvolvido para engenharia de manutenção, proteção e automação de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 🚀 Funcionalidades Principais
- **Leitura Multimodal de Cadernos Elétricos (100+ páginas):** Indexação automática e recorte cirúrgico de diagramas funcionais (`/EL`), réguas de bornes (`/RB`), layout mecânico (`/ME`) e relação de materiais (`/RM`) no padrão WEG / IEC / ANSI.
- **Guia Prático de Ponta de Prova (Multímetro):** Indicação exata de réguas de bornes (`1X2`, `2X2`, `3XD`, `XED`), terminais (`13-14`, `21-22`) e tensões esperadas (`125 Vcc`, `24 Vcc`, `220 Vca`).
- **Inspetor Deep-Link de Folhas do PDF:** Clique em qualquer número de página ou folha no laudo/chat para abrir instantaneamente a página recortada em alta resolução.
- **Banco de Dados em Nuvem Supabase (Projeto: Agenda Financeira youware):** Sincronização em tempo real dos diagnósticos entre múltiplos computadores usando a tabela isolada `hydrodiag_investigations`.

## ☁️ Como Publicar na Vercel + Conectar ao Supabase (Acesso em Qualquer PC)
1. No painel do **Supabase**, abra o projeto **`Agenda Financeira youware`**, clique em **SQL Editor** e execute o arquivo `supabase_hydrodiag_schema.sql`.
2. Acesse [https://vercel.com/new](https://vercel.com/new) e importe este repositório (`hydrodiag-ai-pch-uhe`).
3. Em **Environment Variables** da Vercel, adicione:
   - `GEMINI_API_KEY`: Sua chave da API do Google Gemini
   - `SUPABASE_URL`: `https://oooegbbvrwifilavlvgt.supabase.co`
   - `SUPABASE_ANON_KEY`: A chave `anon public` do seu projeto `Agenda Financeira youware`
4. Clique em **Deploy**. O arquivo `vercel.json` e a função serverless `api/index.ts` já configuram automaticamente o backend e o frontend!
