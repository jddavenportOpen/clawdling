'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2 } from 'lucide-react';
import GlassPanel from '@/components/GlassPanel';
import { DOMAINS } from '@/config/domains';

interface ProjectFormData {
  name: string;
  status: string;
  phase: string;
  repo: string;
  deployed_url: string;
  next_milestone: string;
  owner: string;
  description: string;
  domain: string;
}

interface ProjectFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** If provided, the modal is in "edit" mode */
  editProject?: {
    id: string;
    name: string;
    status: string;
    phase: string | null;
    repo: string | null;
    deployed_url: string | null;
    next_milestone: string | null;
    owner: string | null;
    description?: string | null;
    domain?: string | null;
  } | null;
  /** If provided, pre-selects this domain when creating a new project */
  defaultDomain?: string;
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'planning', label: 'Planning' },
  { value: 'paused', label: 'Paused' },
  { value: 'complete', label: 'Complete' },
  { value: 'archived', label: 'Archived' },
];

const DOMAIN_OPTIONS = [
  { value: '', label: '(none)' },
  ...DOMAINS.map((d) => ({ value: d.id, label: d.label })),
];

const EMPTY_FORM: ProjectFormData = {
  name: '',
  status: 'active',
  phase: '',
  repo: '',
  deployed_url: '',
  next_milestone: '',
  owner: 'JD',
  description: '',
  domain: '',
};

export default function ProjectFormModal({
  isOpen,
  onClose,
  onSaved,
  editProject,
  defaultDomain,
}: ProjectFormModalProps) {
  const isEdit = !!editProject;
  const [form, setForm] = useState<ProjectFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editProject) {
      setForm({
        name: editProject.name,
        status: editProject.status,
        phase: editProject.phase || '',
        repo: editProject.repo || '',
        deployed_url: editProject.deployed_url || '',
        next_milestone: editProject.next_milestone || '',
        owner: editProject.owner || 'JD',
        description: (editProject as Record<string, unknown>).description as string || '',
        domain: editProject.domain || defaultDomain || '',
      });
    } else {
      setForm({ ...EMPTY_FORM, domain: defaultDomain || '' });
    }
    setError(null);
  }, [editProject, isOpen, defaultDomain]);

  // 2026-05-03 H3 fix — Esc dismisses the form modal. Guarded by
  // `saving` so an in-flight POST/PATCH can't be cancelled while the
  // server is still committing.
  useEffect(() => {
    if (!isOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [isOpen, saving, onClose]);

  const handleChange = (field: keyof ProjectFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Project name is required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {};
      if (!isEdit || form.name !== editProject?.name) payload.name = form.name.trim();
      payload.status = form.status;
      if (form.phase) payload.phase = form.phase;
      if (form.repo) payload.repo = form.repo;
      if (form.deployed_url) payload.deployed_url = form.deployed_url;
      if (form.next_milestone) payload.next_milestone = form.next_milestone;
      if (form.owner) payload.owner = form.owner;
      if (form.description) payload.description = form.description;
      payload.domain = form.domain || null;

      const url = isEdit ? `/api/projects/${editProject!.id}` : '/api/projects';
      const method = isEdit ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit ? payload : { ...payload, name: form.name.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Request failed with ${res.status}`);
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto"
            data-testid="project-form-modal"
          >
            <GlassPanel className="p-6" animate={false}>
              {/* Header */}
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-display font-bold text-text-primary">
                  {isEdit ? 'Edit Project' : 'New Project'}
                </h2>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
                  data-testid="project-form-close"
                >
                  <X className="w-4 h-4 text-text-muted" />
                </button>
              </div>

              {/* Error */}
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-neon-red/10 border border-neon-red/20 text-neon-red text-xs font-mono">
                  {error}
                </div>
              )}

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                    Project Name *
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => handleChange('name', e.target.value)}
                    placeholder="My New Project"
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                    disabled={saving}
                  />
                </div>

                {/* Status + Owner row */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                      Status
                    </label>
                    <select
                      value={form.status}
                      onChange={(e) => handleChange('status', e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono appearance-none"
                      disabled={saving}
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value} className="bg-[#0a0a12] text-white">
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                      Owner
                    </label>
                    <input
                      type="text"
                      value={form.owner}
                      onChange={(e) => handleChange('owner', e.target.value)}
                      placeholder="JD"
                      className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                      disabled={saving}
                    />
                  </div>
                </div>

                {/* Domain */}
                <div>
                  <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                    Domain
                  </label>
                  <select
                    value={form.domain}
                    onChange={(e) => handleChange('domain', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono appearance-none"
                    disabled={saving}
                  >
                    {DOMAIN_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-[#0a0a12] text-white">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Phase */}
                <div>
                  <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                    Phase
                  </label>
                  <input
                    type="text"
                    value={form.phase}
                    onChange={(e) => handleChange('phase', e.target.value)}
                    placeholder="Phase 1 - Planning"
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                    disabled={saving}
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                    Description
                  </label>
                  <textarea
                    value={form.description}
                    onChange={(e) => handleChange('description', e.target.value)}
                    placeholder="Brief description of the project..."
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono resize-none"
                    disabled={saving}
                  />
                </div>

                {/* Next Milestone */}
                <div>
                  <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                    Next Milestone
                  </label>
                  <input
                    type="text"
                    value={form.next_milestone}
                    onChange={(e) => handleChange('next_milestone', e.target.value)}
                    placeholder="MVP deploy"
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                    disabled={saving}
                  />
                </div>

                {/* Repo + URL */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                      Repo URL
                    </label>
                    <input
                      type="text"
                      value={form.repo}
                      onChange={(e) => handleChange('repo', e.target.value)}
                      placeholder="https://github.com/..."
                      className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                      disabled={saving}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wider mb-1.5">
                      Live URL
                    </label>
                    <input
                      type="text"
                      value={form.deployed_url}
                      onChange={(e) => handleChange('deployed_url', e.target.value)}
                      placeholder="https://..."
                      className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-neon-cyan/40 transition-colors font-mono"
                      disabled={saving}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-lg text-xs font-mono font-medium text-text-muted hover:bg-white/[0.06] transition-colors border border-white/[0.08]"
                    disabled={saving}
                    data-testid="project-form-cancel"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-lg text-xs font-mono font-bold transition-all duration-200 border"
                    style={{
                      backgroundColor: 'rgba(0, 255, 224, 0.10)',
                      borderColor: 'rgba(0, 255, 224, 0.30)',
                      color: '#00FFE0',
                    }}
                    data-testid="project-form-submit"
                  >
                    {saving ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Saving...
                      </span>
                    ) : isEdit ? (
                      'Save Changes'
                    ) : (
                      'Create Project'
                    )}
                  </button>
                </div>
              </form>
            </GlassPanel>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
