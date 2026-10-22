import { h } from 'preact';
import htm from 'htm';

// One tagged-template renderer for the whole app (no JSX, no build step).
export const html = htm.bind(h);
