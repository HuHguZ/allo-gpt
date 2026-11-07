import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PhoneController} from '../src/controller.js';
import {loadConfig} from '../src/config.js';

test('demo makes no provider requests, rejects concurrent calls, and persists role-separated output', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phone-demo-'));
  const app=new PhoneController(loadConfig({CALLS_DIR:dir}),{demoIntervalMs:5});
  try {
    await app.initialize();
    const done=new Promise<void>(resolve=>{const unsubscribe=app.subscribe(()=>{if(app.getSnapshot().current?.status==='completed'){unsubscribe();resolve();}});});
    await app.startCall('+70000000000','Обсуди поездку');
    await assert.rejects(app.startCall('+70000000000','ещё'),/уже/);
    await done;
    const call=app.getSnapshot().history[0];assert.ok(call);
    assert.equal(call.direction,'demo');assert.ok(call.entries.some(e=>e.role==='human'));assert.ok(call.entries.some(e=>e.role==='agent'));
    assert.equal(call.closeConfirmed,true);
    const saved=JSON.parse(await readFile(join(dir,call.id,'call.json'),'utf8'));
    assert.equal(saved.status,'completed');
    await app.summarize(call.id);assert.match(app.getSnapshot().history[0]?.summary??'',/Демо/);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('hangup during pending dialing cancels it without creating an OpenAI session', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phone-cancel-'));
  class PendingGateway extends EventEmitter {
    canceled=false;
    async connect(){this.emit('status','ready');}
    async dial(_number:string,signal?:AbortSignal):Promise<any>{
      return new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>{this.canceled=true;reject(new Error('Набор отменён'));},{once:true});});
    }
    async close(){}
  }
  const gateway=new PendingGateway();let liveCreations=0;
  const config=loadConfig({PHONE_MODE:'live',OPENAI_API_KEY:'test-key',ASTERISK_ARI_PASSWORD:'local-pass',PLUSOFON_CALLER_NUMBER:'+70000000000',CALLS_DIR:dir});
  const app=new PhoneController(config,{gatewayFactory:()=>gateway,liveFactory:()=>{liveCreations++;throw new Error('must not create');}});
  try {
    await app.initialize();
    const dialing=app.startCall('+70000000000','test');
    await new Promise<void>(resolve=>{const poll=()=>{if(app.getSnapshot().current?.status==='ringing')resolve();else setTimeout(poll,1);};poll();});
    await app.hangup();await dialing;
    assert.equal(gateway.canceled,true);assert.equal(liveCreations,0);assert.equal(app.getSnapshot().current?.status,'completed');
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('missing credentials and invalid destinations never reach the gateway', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phone-config-'));
  const app=new PhoneController(loadConfig({CALLS_DIR:dir}));
  try {
    await app.initialize();await app.setMode('live');
    await assert.rejects(app.startCall('+70000000000','test'),/OPENAI_API_KEY/);
    await app.setMode('demo');
    await assert.rejects(app.startCall('70000000000;bad','test'));
    assert.equal(app.getSnapshot().history.length,0);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('late transcript fragments are retained while OpenAI finalizes after hangup', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phone-drain-'));
  const leg={id:'leg',async startMedia(){},sendAudio(){},async close(){}};
  class ReadyGateway extends EventEmitter {async connect(){this.emit('status','ready');}async dial(){return leg;}async close(){}}
  class FinalVoice extends EventEmitter {
    sessionId='live_mock';async connect(){}sendAudio(){}startConversation(){}instruct(){}
    async close(){this.emit('transcript',{role:'agent',text:'До свидания!',startMs:100,endMs:200});return{confirmed:true,seconds:2};}
  }
  const app=new PhoneController(loadConfig({PHONE_MODE:'live',OPENAI_API_KEY:'test-key',ASTERISK_ARI_PASSWORD:'local-pass',PLUSOFON_CALLER_NUMBER:'+70000000000',CALLS_DIR:dir}),{gatewayFactory:()=>new ReadyGateway(),liveFactory:()=>new FinalVoice()});
  try{await app.initialize();await app.startCall('+70000000000','test');await app.hangup();assert.equal(app.getSnapshot().history[0]?.entries[0]?.text,'До свидания!');}
  finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('cancellation waits for pending phone cleanup and records a cleanup failure', async () => {
  const dir=await mkdtemp(join(tmpdir(),'phone-cleanup-'));
  class SlowGateway extends EventEmitter {
    async connect(){this.emit('status','ready');}
    async dial(_number:string,signal?:AbortSignal):Promise<any>{return new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>setTimeout(()=>reject(new Error('ARI DELETE failed (HTTP 503)')),30),{once:true}));}
    async close(){}
  }
  const app=new PhoneController(loadConfig({PHONE_MODE:'live',OPENAI_API_KEY:'test-key',ASTERISK_ARI_PASSWORD:'local-pass',PLUSOFON_CALLER_NUMBER:'+70000000000',CALLS_DIR:dir}),{gatewayFactory:()=>new SlowGateway()});
  try{
    await app.initialize();const dialing=app.startCall('+70000000000','test');
    await new Promise<void>(resolve=>{const poll=()=>{if(app.getSnapshot().current?.status==='ringing')resolve();else setTimeout(poll,1);};poll();});
    const ending=app.hangup();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(app.getSnapshot().current?.status,'ending');
    await ending;await dialing;assert.equal(app.getSnapshot().history[0]?.status,'failed');assert.match(app.getSnapshot().history[0]?.error??'',/ARI DELETE/);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('saved call metadata cannot open a file outside the recordings directory', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-recording-path-'));await mkdir(join(dir,'call-1'));
  await writeFile(join(dir,'call-1','call.json'),JSON.stringify({id:'call-1',number:'+70000000000',task:'test',startedAt:new Date().toISOString(),status:'completed',entries:[],closeConfirmed:true,recordingPath:join(dir,'outside.exe')}));
  const app=new PhoneController(loadConfig({CALLS_DIR:dir}));
  try{await app.initialize();await assert.rejects(app.playRecording('call-1'),/Недопустимый путь/);}
  finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('a goodbye waits for the agent to stop speaking, then closes both connections',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-goodbye-'));let phoneClosed=false,voiceClosed=false;
  const leg={id:'leg',async startMedia(){},sendAudio(){},async close(){phoneClosed=true;}};
  class ReadyGateway extends EventEmitter{async connect(){this.emit('status','ready');}async dial(){return leg;}async close(){}}
  class Voice extends EventEmitter{async connect(){}sendAudio(){}startConversation(){}instruct(){}async close(){voiceClosed=true;return{confirmed:true,seconds:5};}}
  const gateway=new ReadyGateway(),voice=new Voice();
  const app=new PhoneController(loadConfig({PHONE_MODE:'live',OPENAI_API_KEY:'test-key',ASTERISK_ARI_PASSWORD:'local-pass',PLUSOFON_CALLER_NUMBER:'+70000000000',CALLS_DIR:dir}),{gatewayFactory:()=>gateway,liveFactory:()=>voice});
  try{
    await app.initialize();await app.startCall('+70000000000','test');voice.emit('hangup-requested','caller_goodbye');gateway.emit('agent-speaking',leg.id,true);
    await new Promise(r=>setTimeout(r,50));assert.equal(phoneClosed,false);assert.equal(voiceClosed,false);
    gateway.emit('agent-speaking',leg.id,false);
    for(let n=0;n<100&&app.getSnapshot().current?.status!=='completed';n++)await new Promise(r=>setTimeout(r,20));
    assert.equal(phoneClosed,true);assert.equal(voiceClosed,true);assert.equal(app.getSnapshot().current?.status,'completed');assert.equal(app.getSnapshot().current?.hangupReason,'caller_goodbye');assert.equal(app.getSnapshot().current?.closeConfirmed,true);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
