import React from 'react';
import {render} from 'ink';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {loadConfig,safeError} from './config.js';
import {PhoneController} from './controller.js';
import {App} from './ui.js';

// Both src/cli.tsx and the esbuild entry dist/cli.js are one level below the root.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
try{process.loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const args=new Set(process.argv.slice(2));
try {
  const config=loadConfig();
  if(args.has('--demo'))config.mode='demo';
  if(args.has('--live'))config.mode='live';
  const controller=new PhoneController(config,{...(args.has('--smoke')?{demoIntervalMs:10}:{})});
  await controller.initialize();
  if(args.has('--doctor')){
    for(const check of await controller.doctor())process.stdout.write(`${check.ok?'OK':'--'} ${check.name}: ${check.detail}\n`);
    await controller.close();
  } else if(args.has('--smoke')) {
    if(config.mode!=='demo')throw new Error('--smoke работает только с --demo.');
    const done=new Promise<void>(resolve=>{const unsubscribe=controller.subscribe(()=>{const status=controller.getSnapshot().current?.status;if(status==='completed'||status==='failed'){unsubscribe();resolve();}});});
    await controller.startCall('+70000000000','Проверь интерфейс и сохранение транскрипта.');await done;await controller.close();
    const call=controller.getSnapshot().history[0];
    if(call?.status!=='completed')throw new Error(call?.error||'Демо не завершилось.');
    process.stdout.write(`OK: demo completed, ${call.entries.length} transcript entries.\nFiles: ${call.savedPath}\n`);
  } else {
    if(!process.stdin.isTTY){await controller.close();throw new Error('Откройте терминал и запустите npm start. Для проверки без терминала: npm run demo -- --smoke.');}
    const app=render(<App controller={controller}/>,{exitOnCtrlC:false,alternateScreen:true});
    const terminate=()=>{void controller.close().finally(()=>app.unmount());};
    process.once('SIGTERM',terminate);
    await app.waitUntilExit();await controller.close();process.removeListener('SIGTERM',terminate);
  }
} catch(error) {
  process.stderr.write(safeError(error,[process.env.OPENAI_API_KEY||'',process.env.PLUSOFON_API_TOKEN||'',process.env.ASTERISK_ARI_PASSWORD||'',process.env.TELEGRAM_BOT_TOKEN||''])+'\n');process.exitCode=1;
}
