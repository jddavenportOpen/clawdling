#!/usr/bin/env node
// Stand-in for /usr/bin/osascript in tests: records its argv and sends nothing anywhere.
import fs from 'node:fs';
if (process.env.FAKE_OSASCRIPT_LOG) fs.appendFileSync(process.env.FAKE_OSASCRIPT_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
