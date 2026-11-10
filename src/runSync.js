import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { runSync } from './sync.js';
const report = await runSync();
await mkdir('work/sync', { recursive: true });
await writeFile('work/sync/report.json', JSON.stringify(report, null, 2) + '\n');
if (Object.values(report).some(r=>r.failed)) process.exitCode = 1;
