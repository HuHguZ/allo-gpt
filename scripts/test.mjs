import {mkdtemp,readdir,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sandbox=await mkdtemp(join(tmpdir(),'allo-gpt-tests-'));
try{
  const junctionRoot=join(sandbox,'junction-fixture');
  await mkdir(join(junctionRoot,'calls'),{recursive:true});await mkdir(join(junctionRoot,'external'));
  await writeFile(join(junctionRoot,'external','keep.txt'),'keep');
  await symlink(join(junctionRoot,'external'),join(junctionRoot,'calls','linked-call'),process.platform==='win32'?'junction':'dir');
  const files=(await readdir(join(root,'test'))).filter(file=>/\.test\.tsx?$/.test(file)).map(file=>join(root,'test',file));
  const flags=[process.allowedNodeEnvironmentFlags.has('--permission')?'--permission':'--experimental-permission','--allow-fs-read=*',`--allow-fs-write=${sandbox}`,'--allow-child-process','--allow-worker'];
  if(process.allowedNodeEnvironmentFlags.has('--allow-net'))flags.push('--allow-net');
  const child=spawn(process.execPath,[...flags,'--import',import.meta.resolve('tsx'),'--test',...process.argv.slice(2),...files],{
    cwd:sandbox,stdio:'inherit',env:{...process.env,TMP:sandbox,TEMP:sandbox,TMPDIR:sandbox,ALLO_GPT_JUNCTION_ROOT:junctionRoot,PHONE_MODE:'demo',OPENAI_API_KEY:'',PLUSOFON_API_TOKEN:'',TELEGRAM_BOT_TOKEN:''},
  });
  process.exitCode=await new Promise((ok,fail)=>{child.once('error',fail);child.once('close',code=>ok(code??1));});
}finally{await rm(sandbox,{recursive:true,force:true});}
