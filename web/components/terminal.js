// Preact wrapper around a TermView. The view outlives re-renders (it is keyed by
// sid in the pane list) and is disposed only when the pane leaves the open set.
import { html } from '../lib/html.js';
import { useEffect, useRef } from 'preact/hooks';
import { TermView } from '../lib/term.js';

export function TerminalView({ sid, ended, onConn, onStatus, onEnded }) {
  const host = useRef(null);
  const view = useRef(null);
  const hooks = useRef({});
  hooks.current = { onConn, onStatus, onEnded };

  useEffect(() => {
    const v = new TermView(sid, {
      onConn: (c) => hooks.current.onConn && hooks.current.onConn(c),
      onStatus: (st, m) => hooks.current.onStatus && hooks.current.onStatus(st, m),
      onEnded: () => hooks.current.onEnded && hooks.current.onEnded(),
    });
    view.current = v;
    if (ended) v.setEnded(true);
    v.attach(host.current);
    return () => { v.dispose(); view.current = null; };
  }, [sid]);

  useEffect(() => {
    if (view.current) view.current.setEnded(!!ended);
  }, [ended]);

  return html`<div class="term-host" ref=${host} data-term=${sid}></div>`;
}
