import 'dotenv/config';
import {runClassifications} from './sync.js';
try{const result=await runClassifications();if(result.failed)process.exitCode=1;}
catch{console.error('Classification sync failed; no automatic rollback. Inspect previews and persisted custody state.');process.exitCode=1;}
