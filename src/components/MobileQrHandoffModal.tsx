import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  QrCode,
  Smartphone,
  Laptop,
  ArrowRight,
  Copy,
  Check,
  X,
  Camera,
} from 'lucide-react';

interface MobileQrHandoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  investigationTitle?: string;
}

export const MobileQrHandoffModal: React.FC<MobileQrHandoffModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  investigationTitle,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [openCameraDirectly, setOpenCameraDirectly] = useState<boolean>(true);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);

  const buildHandoffUrl = () => {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    if (openCameraDirectly) {
      url.searchParams.set('camera', '1');
    } else {
      url.searchParams.delete('camera');
    }
    url.hash = 'bancada';
    return url.toString();
  };

  const handoffUrl = buildHandoffUrl();

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    QRCode.toDataURL(handoffUrl, {
      width: 280,
      margin: 2,
      color: {
        dark: '#0B111E',
        light: '#FFFFFF',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen, handoffUrl, onClose]);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(handoffUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2200);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 no-print">
      <div className="bg-[#111827] border border-slate-700 rounded-xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-4 py-3.5 bg-[#0B111E] border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <QrCode className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Passagem Rápida (Notebook ⇄ Celular)
              </h3>
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                <Laptop className="w-3 h-3 text-sky-400" />
                <span>Sala de Comando</span>
                <ArrowRight className="w-3 h-3 text-slate-500" />
                <Smartphone className="w-3 h-3 text-emerald-400" />
                <span>Casa de Força</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1.5 text-slate-400 hover:text-white bg-slate-800/80 hover:bg-rose-600/30 border border-slate-700 rounded-md flex items-center gap-1 cursor-pointer"
          >
            <span className="text-[10px] font-mono">ESC</span>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col items-center text-center gap-4">
          <div className="w-full p-2.5 rounded-lg bg-[#0B111E] border border-slate-800 text-xs">
            <span className="text-slate-400">Investigação Ativa: </span>
            <strong className="text-sky-300 font-mono">
              {investigationTitle || 'Sessão Atual da Bancada'}
            </strong>
          </div>

          {/* QR Code Box */}
          <div className="p-3 bg-white rounded-xl shadow-lg border-4 border-sky-500/40 flex items-center justify-center">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR Code para abrir investigação no celular"
                className="w-56 h-56 object-contain"
              />
            ) : (
              <div className="w-56 h-56 flex items-center justify-center text-xs text-slate-600 font-mono">
                Gerando QR Code...
              </div>
            )}
          </div>

          {/* Option to auto-open Field Camera on mobile */}
          <label className="flex items-center gap-2 text-xs text-slate-200 bg-[#0B111E] border border-slate-800 rounded-lg px-3 py-2 cursor-pointer w-full justify-center">
            <input
              type="checkbox"
              checked={openCameraDirectly}
              onChange={(e) => setOpenCameraDirectly(e.target.checked)}
              className="rounded border-slate-600 text-emerald-500 focus:ring-emerald-500"
            />
            <Camera className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>
              Já abrir com a <strong>Câmera de Campo</strong> ativada no celular
            </span>
          </label>

          <p className="text-xs text-slate-400 leading-relaxed">
            Aponte a câmera do seu celular para o QR Code acima antes de descer
            para a Casa de Força. O celular abrirá diretamente nesta
            investigação sincronizada com o Supabase.
          </p>

          {/* Direct Link Copy */}
          <div className="w-full flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={handoffUrl}
              className="flex-1 bg-[#0B111E] border border-slate-800 rounded-md px-2.5 py-2 text-[11px] font-mono text-slate-300 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopyLink}
              className="px-3 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              {copiedUrl ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-200" />
                  <span>Copiado!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copiar Link</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
