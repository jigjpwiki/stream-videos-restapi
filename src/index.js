import 'dotenv/config';
import { runVideos } from './jobs/videoBatch.js';
try {
  const report = await runVideos();
  if (Object.values(report.results).some(r => !r.success)) process.exitCode = 1;
} catch {
  console.error('Video batch failed; inspect work/videos/report.json and configuration');
  process.exitCode = 1;
}
