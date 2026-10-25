// Entry point of the pty host process (see pty-host.js). Started by the Clawdling server only.
import { loadPtyModules } from './pty.js';
import { runHost } from './pty-host.js';

runHost({ loadPty: () => loadPtyModules() });
