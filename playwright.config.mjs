import {existsSync} from 'node:fs';
import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',outputDir:'work/playwright',reporter:'list',
 use:{baseURL:'http://127.0.0.1:8789',launchOptions:{executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']}},
 webServer:{command:'CLASSIFIER_UI_TEST=1 node tests/browser/server.mjs',url:'http://127.0.0.1:8789',reuseExistingServer:false},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:900}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],
});
