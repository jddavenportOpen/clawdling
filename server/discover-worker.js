// Runs discover() off the server's main thread: the folder walk and file reads are synchronous,
// and on a big home folder they would otherwise stall every terminal and event stream.
import { parentPort, workerData } from 'node:worker_threads';
import { discover } from './discover.js';

discover(workerData).then(
  (body) => parentPort.postMessage({ ok: true, body }),
  (err) => parentPort.postMessage({ ok: false, error: String((err && err.message) || err) })
);
