'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText, ListChecks, Loader2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ProjectDetailModalProps {
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = 'prd' | 'workplan';

const CYAN = '#00FFE0';
const CYAN_FADED = 'rgba(0, 255, 224, 0.10)';
const CYAN_BORDER = 'rgba(0, 255, 224, 0.25)';

// 2026-05-03 M6 fix — replaced the regex-based renderer + dangerouslySetInnerHTML
// pipeline with `react-markdown` + `remark-gfm`. The old renderer escaped
// `&<>` first so it was safe in practice, but ANY tweak that re-introduced
// raw HTML (e.g. someone adding an HTML passthrough) would have created XSS.
// Now: untrusted PRD/workplan content is parsed via mdast and rendered as
// React elements — no HTML string ever touches the DOM. GFM enabled for
// task-list checkboxes ([x] / [ ]) and tables which the prior renderer
// supported partially.
//
// Custom `components` map preserves the existing `.md-*` class names so the
// inline styles below (lines further down) still apply unchanged.

export default function ProjectDetailModal({
  projectName,
  isOpen,
  onClose,
}: ProjectDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('prd');
  const [prd, setPrd] = useState<string | null>(null);
  const [workplan, setWorkplan] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch data when modal opens
  useEffect(() => {
    if (!isOpen || !projectName) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPrd(null);
    setWorkplan(null);
    setActiveTab('prd');

    fetch(`/api/projects/detail?name=${encodeURIComponent(projectName)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setPrd(json.data.prd);
        setWorkplan(json.data.workplan);
        // Default to whichever tab has content
        if (!json.data.prd && json.data.workplan) {
          setActiveTab('workplan');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectName]);

  // Escape key handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  const content = activeTab === 'prd' ? prd : workplan;
  const tabs: { key: TabKey; label: string; icon: typeof FileText }[] = [
    { key: 'prd', label: 'PRD', icon: FileText },
    { key: 'workplan', label: 'Workplan', icon: ListChecks },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90]"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)' }}
            onClick={onClose}
          />

          {/* Modal Panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed inset-4 sm:inset-8 md:inset-12 lg:inset-16 z-[91] flex flex-col rounded-2xl overflow-hidden"
            style={{
              backgroundColor: 'rgba(18, 18, 26, 0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              boxShadow: '0 0 60px rgba(0, 0, 0, 0.5)',
            }}
            data-testid="project-detail-modal"
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-6 py-4 shrink-0"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}
            >
              <div className="flex items-center gap-4">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: CYAN_FADED, border: `1px solid ${CYAN_BORDER}` }}
                >
                  <FileText className="w-4 h-4" style={{ color: CYAN }} />
                </div>
                <div>
                  <h2 className="text-base font-display font-semibold text-text-primary">
                    {projectName}
                  </h2>
                  <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider mt-0.5">
                    project documentation
                  </p>
                </div>
              </div>

              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-white/5 text-text-muted hover:text-text-primary transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tab Pills */}
            <div
              className="flex gap-2 px-6 py-3 shrink-0"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
            >
              {tabs.map((tab) => {
                const isActive = activeTab === tab.key;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    data-testid={`project-detail-tab-${tab.key}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-medium border transition-all duration-200"
                    style={
                      isActive
                        ? { backgroundColor: CYAN_FADED, borderColor: CYAN_BORDER, color: CYAN }
                        : {
                            backgroundColor: 'transparent',
                            borderColor: 'rgba(255, 255, 255, 0.08)',
                            color: 'var(--text-muted)',
                          }
                    }
                  >
                    <Icon className="w-3 h-3" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {loading && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: CYAN }} />
                    <span className="text-sm font-mono text-text-muted">Loading documentation...</span>
                  </div>
                </div>
              )}

              {error && !loading && (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm font-mono text-red-400">
                    Failed to load: {error}
                  </p>
                </div>
              )}

              {!loading && !error && content === null && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
                  >
                    <FileText className="w-8 h-8 text-text-muted" style={{ opacity: 0.3 }} />
                  </div>
                  <p className="text-sm text-text-secondary mb-1">
                    No {activeTab === 'prd' ? 'PRD' : 'Workplan'} available
                  </p>
                  <p className="text-xs text-text-muted font-mono">
                    This project does not have a {activeTab === 'prd' ? 'PRD' : 'workplan'} file configured.
                  </p>
                </div>
              )}

              {!loading && !error && content !== null && (
                <div className="markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 className="md-h1">{children}</h1>,
                      h2: ({ children }) => <h2 className="md-h2">{children}</h2>,
                      h3: ({ children }) => <h3 className="md-h3">{children}</h3>,
                      h4: ({ children }) => <h4 className="md-h4">{children}</h4>,
                      p: ({ children }) => <p className="md-p">{children}</p>,
                      strong: ({ children }) => <strong className="md-bold">{children}</strong>,
                      hr: () => <hr className="md-hr" />,
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="md-link"
                        >
                          {children}
                        </a>
                      ),
                      // Task list items render as <li> with a checked input.
                      // We re-skin them via .md-checkbox / .md-checkbox.checked
                      // so the existing CSS keeps working.
                      li: ({ children, className, ...props }) => {
                        const isTaskItem =
                          (props as { checked?: boolean | null }).checked === true ||
                          (props as { checked?: boolean | null }).checked === false;
                        if (isTaskItem) {
                          const checked = (props as { checked?: boolean }).checked;
                          return (
                            <div className={`md-checkbox${checked ? ' checked' : ''}`}>
                              {children}
                            </div>
                          );
                        }
                        return <div className={`md-li${className ? ' ' + className : ''}`}>{children}</div>;
                      },
                      // remark-gfm task-list inputs: hide the actual checkbox
                      // since our .md-checkbox::before pseudo-element draws it.
                      input: ({ type, ...rest }) =>
                        type === 'checkbox' ? <span style={{ display: 'none' }} /> : <input type={type} {...rest} />,
                      ul: ({ children }) => <>{children}</>,
                      ol: ({ children }) => <>{children}</>,
                      code: ({ inline, children, ...rest }: { inline?: boolean; children?: React.ReactNode }) =>
                        inline ? (
                          <code className="md-inline-code" {...rest}>{children}</code>
                        ) : (
                          <code {...rest}>{children}</code>
                        ),
                      pre: ({ children }) => <pre className="md-code-block">{children}</pre>,
                    }}
                  >
                    {content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </motion.div>

          {/* Markdown Styles — plain <style> for global scope */}
          <style dangerouslySetInnerHTML={{ __html: `
            .markdown-content {
              color: var(--text-secondary, #b0b0c0);
              font-family: var(--font-mono, monospace);
              font-size: 13px;
              line-height: 1.7;
            }
            .markdown-content .md-h1 {
              font-family: var(--font-display, sans-serif);
              font-size: 1.5rem;
              font-weight: 700;
              color: var(--text-primary, #e8e8f0);
              margin: 1.5rem 0 0.75rem 0;
              padding-bottom: 0.5rem;
              border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }
            .markdown-content .md-h2 {
              font-family: var(--font-display, sans-serif);
              font-size: 1.2rem;
              font-weight: 600;
              color: ${CYAN};
              margin: 1.25rem 0 0.5rem 0;
            }
            .markdown-content .md-h3 {
              font-family: var(--font-display, sans-serif);
              font-size: 1rem;
              font-weight: 600;
              color: var(--text-primary, #e8e8f0);
              margin: 1rem 0 0.4rem 0;
            }
            .markdown-content .md-h4 {
              font-size: 0.9rem;
              font-weight: 600;
              color: var(--text-secondary, #b0b0c0);
              margin: 0.75rem 0 0.3rem 0;
            }
            .markdown-content .md-p {
              margin: 0.5rem 0;
            }
            .markdown-content .md-bold {
              color: var(--text-primary, #e8e8f0);
              font-weight: 600;
            }
            .markdown-content .md-li {
              padding-left: 1rem;
              position: relative;
              margin: 0.2rem 0;
            }
            .markdown-content .md-li::before {
              content: '';
              position: absolute;
              left: 0;
              top: 0.6em;
              width: 4px;
              height: 4px;
              border-radius: 50%;
              background: ${CYAN};
              opacity: 0.6;
            }
            .markdown-content .md-li.md-ol::before {
              content: none;
            }
            .markdown-content .md-checkbox {
              padding-left: 1.5rem;
              position: relative;
              margin: 0.2rem 0;
              color: var(--text-muted, #666680);
            }
            .markdown-content .md-checkbox::before {
              content: '';
              position: absolute;
              left: 0;
              top: 0.3em;
              width: 12px;
              height: 12px;
              border-radius: 3px;
              border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .markdown-content .md-checkbox.checked {
              color: var(--text-secondary, #b0b0c0);
            }
            .markdown-content .md-checkbox.checked::before {
              background: ${CYAN};
              opacity: 0.6;
              border-color: ${CYAN};
            }
            .markdown-content .md-inline-code {
              background: rgba(255, 255, 255, 0.06);
              border: 1px solid rgba(255, 255, 255, 0.08);
              border-radius: 4px;
              padding: 0.1em 0.4em;
              font-size: 0.9em;
              color: ${CYAN};
            }
            .markdown-content .md-code-block {
              background: rgba(0, 0, 0, 0.3);
              border: 1px solid rgba(255, 255, 255, 0.06);
              border-radius: 8px;
              padding: 1rem;
              margin: 0.75rem 0;
              overflow-x: auto;
              font-size: 12px;
              line-height: 1.5;
            }
            .markdown-content .md-code-block code {
              color: var(--text-secondary, #b0b0c0);
            }
            .markdown-content .md-hr {
              border: none;
              border-top: 1px solid rgba(255, 255, 255, 0.06);
              margin: 1rem 0;
            }
            .markdown-content .md-link {
              color: ${CYAN};
              text-decoration: underline;
              text-decoration-color: rgba(0, 255, 224, 0.3);
              text-underline-offset: 2px;
            }
            .markdown-content .md-link:hover {
              text-decoration-color: ${CYAN};
            }
          ` }} />
        </>
      )}
    </AnimatePresence>
  );
}
