'use client';

import { useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';
import GlassPanel from '@/components/GlassPanel';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmColor?: 'red' | 'cyan';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  // Optional extra UI rendered between the message and the buttons — e.g. a
  // reason input for an audited remove. Additive: existing callers ignore it.
  bodySlot?: React.ReactNode;
}

export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmColor = 'red',
  loading = false,
  onConfirm,
  onCancel,
  bodySlot,
}: ConfirmDialogProps) {
  // 2026-05-03 H1 fix — Esc dismisses dialog. Pattern lifted from
  // ProjectDetailModal.tsx:148-160. Guarded by `loading` so a delete in
  // flight can't be cancelled by a stray Esc press.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    },
    [loading, onCancel],
  );
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  const colorMap = {
    red: {
      bg: 'rgba(255, 50, 50, 0.10)',
      border: 'rgba(255, 50, 50, 0.30)',
      text: '#FF5555',
    },
    cyan: {
      bg: 'rgba(0, 255, 224, 0.10)',
      border: 'rgba(0, 255, 224, 0.30)',
      text: '#00FFE0',
    },
  };

  const colors = colorMap[confirmColor];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={onCancel}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm"
            data-testid="confirm-dialog"
          >
            <GlassPanel className="p-6" animate={false}>
              <div className="flex items-start gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-neon-red/10 border border-neon-red/20 flex-shrink-0">
                  <AlertTriangle className="w-4 h-4 text-neon-red" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
                  <p className="text-xs font-mono text-text-muted leading-relaxed">{message}</p>
                </div>
              </div>

              {bodySlot && <div className="mb-4">{bodySlot}</div>}

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={onCancel}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg text-xs font-mono font-medium text-text-muted hover:bg-white/[0.06] transition-colors border border-white/[0.08]"
                  data-testid="confirm-dialog-cancel"
                >
                  Cancel
                </button>
                <button
                  onClick={onConfirm}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg text-xs font-mono font-bold transition-all duration-200 border"
                  style={{
                    backgroundColor: colors.bg,
                    borderColor: colors.border,
                    color: colors.text,
                  }}
                  data-testid="confirm-dialog-confirm"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Working...
                    </span>
                  ) : (
                    confirmLabel
                  )}
                </button>
              </div>
            </GlassPanel>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
