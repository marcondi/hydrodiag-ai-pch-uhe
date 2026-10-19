# ⚡ HydroDiag AI — Sistema de Diagnóstico Eletromecânico, Supervisório e Resolução de Falhas (PCH / UHE)

Sistema especialista multimodal desenvolvido para engenharia de manutenção, proteção e automação de **Pequenas Centrais Hidrelétricas (PCH)** e **Usinas Hidrelétricas (UHE)**.

## 🚀 Funcionalidades Principais
- **Leitura Multimodal de Cadernos Elétricos (100+ páginas):** Indexação automática e recorte cirúrgico de diagramas funcionais (`/EL`), réguas de bornes (`/RB`), layout mecânico (`/ME`) e relação de materiais (`/RM`) no padrão WEG / IEC / ANSI.
- **Guia Prático de Ponta de Prova (Multímetro):** Indicação exata de réguas de bornes (`1X2`, `2X2`, `3XD`, `XED`), terminais (`13-14`, `21-22`) e tensões esperadas (`125 Vcc`, `24 Vcc`, `220 Vca`).
- **Chat Técnico Contínuo com o Especialista Gemini:** Converse em tempo real sobre a falha, envie fotos de medições em campo e peça análise de folhas complementares sem perder o contexto.
- **Banco de Dados Persistente de Histórico de Falhas:** Busque rapidamente diagnósticos anteriores, registre a solução confirmada em campo e exporte Ordens de Serviço.

## 🛠️ Como Executar Localmente
```bash
npm install
cp .env.example .env
# Adicione sua GEMINI_API_KEY no arquivo .env
npm run dev
```
