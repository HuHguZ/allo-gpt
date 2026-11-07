import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {LiveSession} from '../src/live.js';
import {loadConfig} from '../src/config.js';

test('Live handshake, PCM, transcript deduplication and confirmed final usage use the new API', async () => {
  const server = new WebSocketServer({port:0});
  await once(server,'listening');
  const address=server.address(); assert.ok(typeof address === 'object' && address);
  const received: any[]=[];
  server.on('connection',(socket,req)=>{
    assert.equal(req.headers.authorization,'Bearer test-key');
    socket.on('message',buffer=>{
      const e=JSON.parse(buffer.toString()); received.push(e);
      if(e.type==='session.start') {
        socket.send(JSON.stringify({type:'session.started',session:{id:'live_test'}}));
        const fragment={type:'session.input_transcript.delta',event_id:'same',delta:'Привет',start_ms:10,end_ms:200};
        socket.send(JSON.stringify(fragment)); socket.send(JSON.stringify(fragment));
        socket.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.from([1,2]).toString('base64')}));
      }
      if(e.type==='session.close') setTimeout(()=>socket.send(JSON.stringify({type:'session.closed',usage:{seconds:12},reason:'close_requested'})),20);
    });
  });
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'Поговори по-русски',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:500});
  const fragments:any[]=[]; live.on('transcript', e=>fragments.push(e));
  const audio=once(live,'audio');
  try {
    await live.connect();
    assert.deepEqual((await audio)[0], Buffer.from([1,2]));
    live.sendAudio(Buffer.from([3,4]));
    live.startConversation();
    live.instruct('Уточни город');
    for(let i=0;i<100&&!received.some(e=>e.type==='session.input_audio.append');i++)await new Promise(r=>setTimeout(r,5));
    const result=await live.close();
    assert.equal(result.confirmed,true); assert.equal(result.seconds,12);
    assert.equal(fragments.length,1);
    assert.equal(received[0].session.model,'gpt-live-1');
    assert.equal(received[0].session.delegation.type,'responses');
    assert.deepEqual(received[0].session.audio.format,{type:'audio/pcm',rate:24000});
    assert.ok(received.some(e=>e.type==='session.input_audio.append'));
    assert.ok(received.some(e=>e.type==='session.instructions.append' && e.content==='Уточни город' && e.delegation_id===null));
  } finally { await live.close(); for(const c of server.clients)c.terminate(); await new Promise<void>(r=>server.close(()=>r())); }
});

test('socket loss is not reported as confirmed finalization', async () => {
  const server=new WebSocketServer({port:0}); await once(server,'listening');
  const address=server.address(); assert.ok(typeof address==='object' && address);
  server.on('connection',s=>s.on('message',b=>{
    const e=JSON.parse(b.toString());
    if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_lost'}}));
    if(e.type==='session.close')s.close();
  }));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:100});
  live.on('failure',()=>{});
  await live.connect(); assert.equal((await live.close()).confirmed,false);
  for(const c of server.clients)c.terminate(); await new Promise<void>(r=>server.close(()=>r()));
});

test('conversation advances on silence, preserves queued PCM and stops audio when closed', async () => {
  const server=new WebSocketServer({port:0});await once(server,'listening');const address=server.address();assert.ok(typeof address==='object'&&address);
  const received:any[]=[];
  server.on('connection',s=>s.on('message',b=>{const e=JSON.parse(b.toString());received.push(e);if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_clock'}}));if(e.type==='session.close')s.send(JSON.stringify({type:'session.closed',usage:{seconds:1}}));}));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:500});
  try {
    await live.connect();live.sendAudio(Buffer.from([3,4]));live.startConversation();
    for(let i=0;i<100&&received.filter(e=>e.type==='session.input_audio.append').length<3;i++)await new Promise(r=>setTimeout(r,5));
    const frames=received.filter(e=>e.type==='session.input_audio.append').map(e=>Buffer.from(e.audio,'base64'));
    assert.ok(frames.length>=3);assert.ok(frames.every(b=>b.length>=960&&b.length%960===0));assert.deepEqual(frames[0]!.subarray(0,2),Buffer.from([3,4]));assert.ok(frames[0]!.subarray(2).every(b=>b===0));assert.ok(frames[1]!.every(b=>b===0));
    assert.ok(received.some(e=>e.type==='session.commentary.append'&&e.delegation_id===null));
    await live.close();const count=received.filter(e=>e.type==='session.input_audio.append').length;await new Promise(r=>setTimeout(r,60));assert.equal(received.filter(e=>e.type==='session.input_audio.append').length,count);
  }finally{await live.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('a rejected steering command is reported without killing the conversation', async () => {
  const server=new WebSocketServer({port:0});await once(server,'listening');const address=server.address();assert.ok(typeof address==='object'&&address);
  server.on('connection',s=>s.on('message',b=>{
    const e=JSON.parse(b.toString());
    if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_steer'}}));
    if(e.type==='session.instructions.append')s.send(JSON.stringify({type:'error',error:{code:'invalid_request_error',message:'Instruction exceeds token limit',client_event_id:e.event_id}}));
    if(e.type==='session.close')s.send(JSON.stringify({type:'session.closed',usage:{seconds:1}}));
  }));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:100});let fatal=0;live.on('failure',()=>fatal++);
  try{await live.connect();const notice=once(live,'notice',{signal:AbortSignal.timeout(300)});live.instruct('Подсказка');await notice;assert.equal(fatal,0);assert.equal((await live.close()).confirmed,true);}
  finally{await live.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('lost transport tries authenticated HTTP hangup but keeps final usage unconfirmed', async () => {
  const http=createServer((req,res)=>{assert.equal(req.method,'POST');assert.equal(req.url,'/v1/live/sessions/live_fallback/hangup');assert.equal(req.headers.authorization,'Bearer test-key');hangups++;res.writeHead(200).end();});
  let hangups=0;const ws=new WebSocketServer({server:http});http.listen(0);await once(http,'listening');const address=http.address();assert.ok(typeof address==='object'&&address);
  ws.on('connection',s=>s.on('message',b=>{const e=JSON.parse(b.toString());if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_fallback'}}));if(e.type==='session.close')s.close();}));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:100});live.on('failure',()=>{});
  try{await live.connect();assert.equal((await live.close()).confirmed,false);assert.equal(hangups,1);}
  finally{await live.close();for(const c of ws.clients)c.terminate();await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));}
});

test('an incomplete backend handoff preserves the voice session and asks for recovery', async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');const address=server.address();assert.ok(typeof address==='object'&&address);const received:any[]=[];
  server.on('connection',s=>s.on('message',b=>{const e=JSON.parse(b.toString());received.push(e);if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_backend_error'}}));if(e.type==='session.commentary.append'&&received.filter(e=>e.type==='session.commentary.append').length===1)s.send(JSON.stringify({type:'error',error:{type:'invalid_request_error',code:'invalid_request_error',message:'Responses handoff incomplete.'}}));if(e.type==='session.close')s.send(JSON.stringify({type:'session.closed',usage:{seconds:2}}));}));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:300});let fatal=0;live.on('failure',()=>fatal++);
  try{await live.connect();live.startConversation();await new Promise(r=>setTimeout(r,80));assert.equal(fatal,0);assert.ok(received.some(e=>e.type==='session.commentary.append'&&/Поиск не завершился/.test(e.content)));assert.ok(!received.some(e=>e.type==='session.close'));assert.equal((await live.close()).confirmed,true);}
  finally{await live.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('end_call validates its reason, deduplicates calls and returns tool results before continuing',async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');const address=server.address();assert.ok(typeof address==='object'&&address);let remote:any;const received:any[]=[];
  server.on('connection',s=>{remote=s;s.on('message',b=>{const e=JSON.parse(b.toString());received.push(e);if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_goodbye'}}));if(e.type==='session.close')s.send(JSON.stringify({type:'session.closed',usage:{seconds:3}}));});});
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:300});const reasons:string[]=[];live.on('hangup-requested',reason=>reasons.push(reason));
  try{await live.connect();for(const [id,reason]of [['bad','other'],['good','caller_goodbye'],['good','caller_goodbye']])remote.send(JSON.stringify({type:'response.event',event_id:Math.random().toString(),event:{type:'response.output_item.done',item:{type:'function_call',name:'end_call',call_id:id,arguments:JSON.stringify({reason})}}}));await new Promise(r=>setTimeout(r,60));assert.deepEqual(reasons,['caller_goodbye']);const outputs=received.filter(e=>e.type==='response.item.create');assert.equal(outputs.length,2);assert.equal(JSON.parse(outputs[0].item.output).status,'rejected');assert.equal(JSON.parse(outputs[1].item.output).status,'scheduled');assert.equal(received.filter(e=>e.type==='response.create').length,2);await live.close();}
  finally{await live.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('delayed audio timer callbacks keep pace with real time without losing caller PCM',async t=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');const address=server.address();assert.ok(typeof address==='object'&&address);
  const frames:Buffer[]=[];server.on('connection',s=>s.on('message',b=>{const e=JSON.parse(b.toString());if(e.type==='session.start')s.send(JSON.stringify({type:'session.started',session:{id:'live_clock_drift'}}));if(e.type==='session.input_audio.append')frames.push(Buffer.from(e.audio,'base64'));if(e.type==='session.close')s.send(JSON.stringify({type:'session.closed',usage:{seconds:30}}));}));
  const live=new LiveSession(loadConfig({OPENAI_API_KEY:'test-key'}),'test',{url:`ws://127.0.0.1:${address.port}/v1/live/sessions`,closeTimeoutMs:500});const failures:string[]=[];live.on('failure',e=>failures.push(e));
  try{
    await live.connect();let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});live.startConversation();
    // 30 seconds of input; each nominal 20 ms timer callback actually arrives after 25 ms.
    const input=Buffer.alloc(1440000,37);
    for(let n=0;n<1200;n++){now+=25;live.sendAudio(input.subarray(n*1200,(n+1)*1200));t.mock.timers.tick(20);if(n%25===0)await new Promise(r=>setImmediate(r));}
    await live.close();assert.deepEqual(failures,[]);assert.deepEqual(Buffer.concat(frames),input);
  }finally{t.mock.timers.reset();t.mock.restoreAll();await live.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
