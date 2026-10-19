# ⚡ HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas (PCH / UHE)

Sistema especialista multimodal desenvolvido para engenharia de manutenção, proteção e automação de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 🚀 Funcionalidades Principais
- **Leitura Multimodal de Cadernos Elétricos (100+ páginas):** Indexação automática e recorte cirúrgico de diagramas funcionais (`/EL`), réguas de bornes (`/RB`), layout mecânico (`/ME`) e relação de materiais (`/RM`) no padrão WEG / IEC / ANSI.
- **Guia Prático de Ponta de Prova (Multímetro):** Indicação exata de réguas de bornes (`1X2`, `2X2`, `3XD`, `XED`), terminais (`13-14`, `21-22`) e tensões esperadas (`125 Vcc`, `24 Vcc`, `220 Vca`).
- **Chat Técnico Contínuo com o Especialista Gemini:** Converse em tempo real sobre a falha, envie fotos de medições em campo e peça análise de folhas complementares sem perder o contexto.
- **Banco de Dados Persistente de Histórico de Falhas:** Busque rapidamente diagnósticos anteriores, registre a solução confirmada em campo e exporte Ordens de Serviço.

## ☁️ Como Publicar na Vercel (Acesso em Qualquer PC)
1. Acesse [https://vercel.com/new](https://vercel.com/new) e importe este repositório (`hydrodiag-ai-pch-uhe`).
2. Em **Environment Variables**, adicione:
   - Nome: `GEMINI_API_KEY`
   - Valor: Sua chave da API do Google Gemini (obtenha gratuitamente em [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
3. Clique em **Deploy**. O arquivo `vercel.json` e a função serverless `api/index.ts` já configuram automaticamente o backend e o frontend!
