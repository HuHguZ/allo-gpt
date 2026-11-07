import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AsteriskGateway} from '../src/asterisk.js';
import {loadConfig,safeError} from '../src/config.js';
import type {PhoneLeg} from '../src/types.js';

try{process.loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const config=loadConfig();
// This placeholder is used only for a Local/Echo channel; it never reaches a SIP trunk.
const gateway=new AsteriskGateway({...config.gateway,app:`${config.gateway.app}-check-${randomUUID().slice(0,8)}`,callerNumber:config.gateway.callerNumber||'+70000000000'});
const channelId=randomUUID();let leg:PhoneLeg|undefined;
let timer:ReturnType<typeof setTimeout>|undefined;
try {
  const incoming=new Promise<PhoneLeg>((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Local Echo did not enter the app within 10 seconds.')),10000);
    gateway.once('incoming',(value:PhoneLeg)=>{clearTimeout(timer);resolve(value);});
    gateway.on('error',reject);
  });
  await gateway.connect();
  await gateway.request('POST','/channels',{endpoint:'Local/echo@gpt-test/n',app:gateway.config.app,appArgs:'incoming',channelId,timeout:'5'});
  leg=await incoming;
  let receivedBytes=0;
  let resolveEcho!:()=>void;
  const echoed=new Promise<void>((resolve,reject)=>{resolveEcho=resolve;timer=setTimeout(()=>reject(new Error('No non-silent PCM returned from Local Echo.')),10000);});
  await leg.startMedia(audio=>{if(audio.some(value=>value!==0)){receivedBytes+=audio.length;resolveEcho();}});
  const pcm=Buffer.alloc(9600);
  for(let i=0;i<4800;i++)pcm.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*8000),i*2);
  leg.sendAudio(pcm);await echoed;clearTimeout(timer);
  assert.ok(receivedBytes>0,'Asterisk must echo actual non-silent PCM');
  await leg.close();await gateway.close();
  const channels=await gateway.request<Array<{id:string}>>('GET','/channels');
  assert.ok(!channels.some(c=>c.id===channelId),'Originated channel must be removed');
  console.log(`OK: real Asterisk Local/Echo, 24 kHz PCM returned (${receivedBytes} bytes), channels cleaned up. No PSTN or OpenAI call.`);
} catch(error){process.stderr.write(safeError(error,[config.gateway.ariPassword])+'\n');process.exitCode=1;}
finally{clearTimeout(timer);await leg?.close().catch(()=>{});await gateway.close().catch(()=>{});}
