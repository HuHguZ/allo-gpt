import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PhoneController} from '../src/controller.js';
import {loadConfig} from '../src/config.js';
import {CallStore} from '../src/store.js';
import type {CallRecord} from '../src/types.js';

async function fixture(playerFactory:(file:string,position:number)=>ChildProcess,check:(app:PhoneController,calls:CallRecord[])=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'phone-playback-')),previous=process.cwd();
  let app:PhoneController|undefined;
  try{
    process.chdir(root);await mkdir('recordings');const store=new CallStore(join(root,'calls')),calls:CallRecord[]=[];
    for(let i=0;i<2;i++){
      const call:CallRecord={id:randomUUID(),direction:'demo',number:'+70000000000',task:'Тест',startedAt:new Date().toISOString(),status:'completed',entries:[],closeConfirmed:true,recordingPath:join(root,'recordings',randomUUID()+'.wav')};
      const wav=Buffer.alloc(44+20*16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
      await writeFile(call.recordingPath!,wav);await store.save(call);calls.push(call);
    }
    app=new PhoneController(loadConfig({CALLS_DIR:store.root}),{playerFactory});await app.initialize();await check(app,calls);
  }finally{await app?.close().catch(()=>{});process.chdir(previous);await rm(root,{recursive:true,force:true});}
}
const exited=(child:ChildProcess)=>child.exitCode!==null||child.signalCode!==null;

test('playback owns one process and stops it when switching, stopping, deleting or starting a call',async()=>{
  const players:ChildProcess[]=[];
  await fixture(()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});players.push(child);return child;},async(app,calls)=>{
    await app.playRecording(calls[0]!.id);assert.equal(app.getSnapshot().playback?.id,calls[0]!.id);
    await app.playRecording(calls[1]!.id);assert.ok(exited(players[0]!));assert.equal(app.getSnapshot().playback?.id,calls[1]!.id);
    await app.stopRecording();assert.ok(exited(players[1]!));assert.equal(app.getSnapshot().playback?.id,undefined);
    await app.playRecording(calls[0]!.id);await app.deleteHistory(calls[0]!.id);assert.ok(exited(players[2]!));
    await assert.rejects(access(calls[0]!.recordingPath!),{code:'ENOENT'});
    await app.playRecording(calls[1]!.id);await app.startCall('+70000000000');assert.ok(exited(players[3]!));
    await assert.rejects(app.playRecording(calls[1]!.id),/звонок/i);await app.hangup();
    await app.playRecording(calls[1]!.id);await app.close();assert.ok(exited(players[4]!));
  });
});

test('recording progress, pause and seeking preserve position and own only one process',async()=>{
  const starts:number[]=[],players:ChildProcess[]=[];
  await fixture((_file,position)=>{starts.push(position);const child=spawn(process.execPath,['-e',`process.stderr.write('  ${(position+1).toFixed(2)} M-A: 0.000\\r');setInterval(()=>{},1000)`],{stdio:['ignore','ignore','pipe'],windowsHide:true});players.push(child);return child;},async(app,calls)=>{
    await app.playRecording(calls[0]!.id);for(let i=0;i<100&&app.getSnapshot().playback?.positionSeconds!==1;i++)await delay(10);
    assert.equal(app.getSnapshot().playback?.positionSeconds,1);assert.equal(app.getSnapshot().playback?.durationSeconds,20);
    await app.pauseRecording();assert.ok(exited(players[0]!));assert.equal(app.getSnapshot().playback?.paused,true);
    await app.seekRecording(12);assert.equal(players.length,1);assert.equal(app.getSnapshot().playback?.positionSeconds,12);
    await app.playRecording(calls[0]!.id,12);assert.deepEqual(starts,[0,12]);
    await app.seekRecording(-100);assert.ok(exited(players[1]!));assert.equal(starts.at(-1),0);
    await assert.rejects(app.seekRecording(NaN),/позици/i);
    await app.seekRecording(500);assert.equal(app.getSnapshot().playback?.positionSeconds,20);assert.equal(app.getSnapshot().playback?.paused,true);assert.ok(exited(players.at(-1)!));
    await app.deleteHistory(calls[0]!.id);assert.equal(app.getSnapshot().playback,undefined);
  });
});

test('natural playback completion leaves the player paused at the end',async()=>{
  await fixture(()=>spawn(process.execPath,['-e','setTimeout(()=>{},100)'],{stdio:'ignore',windowsHide:true}),async(app,calls)=>{
    await app.playRecording(calls[0]!.id);
    for(let i=0;i<100&&!app.getSnapshot().playback?.paused;i++)await delay(10);
    assert.equal(app.getSnapshot().playback?.paused,true);assert.equal(app.getSnapshot().playback?.positionSeconds,20);assert.match(app.getSnapshot().notice,/завершено/i);
  });
});

test('a missing audio player produces a useful error without leaving playback active',async()=>{
  await fixture(()=>spawn('allo-gpt-missing-player-123456',[],{stdio:'ignore',windowsHide:true}),async(app,calls)=>{
    await assert.rejects(app.playRecording(calls[0]!.id),/ffplay/i);assert.equal(app.getSnapshot().playback?.id,undefined);
  });
});

test('a corrupt recording is rejected before an audio process is launched',async()=>{
  await fixture(()=>{throw new Error('Player must not start');},async(app,calls)=>{
    await writeFile(calls[0]!.recordingPath!,Buffer.alloc(100));
    await assert.rejects(app.playRecording(calls[0]!.id),/WAV/);assert.equal(app.getSnapshot().playback,undefined);
  });
});
