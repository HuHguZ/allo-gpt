import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access,readdir,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import React from 'react';
import {render} from 'ink-testing-library';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CallStore} from '../src/store.js';
import {PhoneController} from '../src/controller.js';
import {loadConfig} from '../src/config.js';
import type {CallRecord} from '../src/types.js';
import {App} from '../src/ui.js';

const record=(id=randomUUID()):CallRecord=>({id,direction:'demo',number:'+70000000000',task:'Проверка',startedAt:new Date().toISOString(),status:'completed',entries:[],closeConfirmed:true});

test('deletion removes every call file and its distinct recording, without resurrecting queued saves',async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-delete-'));
  const store=new CallStore(join(root,'calls'),join(root,'recordings'));
  try{
    const recordings=join(root,'recordings');await mkdir(recordings);
    const call={...record(),recordingPath:join(recordings,randomUUID()+'.wav')};
    const other=record();await store.save(other);
    await writeFile(call.recordingPath,'synthetic audio');
    const pending=store.save(call);
    const deleting=store.remove(call);
    const late=store.save(call);
    const results=await Promise.allSettled([pending,deleting,late]);
    assert.equal(results[0]!.status,'fulfilled');assert.equal(results[1]!.status,'fulfilled');assert.equal(results[2]!.status,'rejected');
    await assert.rejects(access(store.directory(call.id)),{code:'ENOENT'});
    await assert.rejects(access(call.recordingPath),{code:'ENOENT'});
    assert.equal((await store.load())[0]?.id,other.id);
  }finally{await store.flush().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('deletion rejects escaped recording paths and directory junctions before touching call data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-delete-path-'));
  try{
    const store=new CallStore(join(root,'calls'),join(root,'recordings'));
    const call=record();await store.save(call);
    const outside=join(root,randomUUID()+'.wav');await writeFile(outside,'keep');
    await assert.rejects(store.remove({...call,recordingPath:outside}),/путь/i);
    assert.equal(await readFile(outside,'utf8'),'keep');await access(join(store.directory(call.id),'call.json'));
    // The runner creates this safe fixture before Node forbids symlink creation.
    const junctionRoot=process.env.ALLO_GPT_JUNCTION_ROOT;assert.ok(junctionRoot,'Run through npm test.');
    const linkedStore=new CallStore(join(junctionRoot,'calls'));
    await assert.rejects(linkedStore.remove({id:'linked-call'}),/путь/i);
    assert.equal(await readFile(join(junctionRoot,'external','keep.txt'),'utf8'),'keep');
    await store.flush();await linkedStore.flush();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('controller deletes selected or all saved calls, clears the current selection and protects active calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-delete-controller-')),previous=process.cwd();
  process.chdir(root);
  const app=new PhoneController(loadConfig({CALLS_DIR:root}),{demoIntervalMs:1000});
  try{
    await app.initialize();await app.startCall('+70000000000');
    assert.ok(app.getSnapshot().current?.task.trim(),'An empty task must use the default prompt');
    await assert.rejects(app.deleteHistory(),/звонок/i);
    await app.hangup();const first=app.getSnapshot().history[0]!;
    await app.startCall('+70000000000','другой');await app.hangup();
    const second=app.getSnapshot().history[0]!;
    await app.deleteHistory(second.id);
    assert.equal(app.getSnapshot().current,undefined);assert.deepEqual(app.getSnapshot().history.map(call=>call.id),[first.id]);
    await assert.rejects(access(join(root,second.id)),{code:'ENOENT'});
    const deleting=app.deleteHistory();
    await assert.rejects(app.startCall('+70000000000'),/удаления/);
    await deleting;assert.deepEqual(app.getSnapshot().history,[]);
    assert.deepEqual(await new CallStore(root).load(),[]);
  }finally{await app.close();process.chdir(previous);await rm(root,{recursive:true,force:true});}
});

test('history buttons remove real fixture WAV and transcript files end to end',async()=>{
  const root=await mkdtemp(join(tmpdir(),'phone-delete-ui-')),previous=process.cwd();
  let app:PhoneController|undefined,ui:ReturnType<typeof render>|undefined;
  try{
    process.chdir(root);await mkdir('recordings');
    const store=new CallStore(join(root,'calls'));
    for(let i=0;i<2;i++){
      const call={...record(),recordingPath:join(root,'recordings',randomUUID()+'.wav')};
      await writeFile(call.recordingPath,Buffer.alloc(100));await store.save(call);
    }
    app=new PhoneController(loadConfig({CALLS_DIR:store.root}));await app.initialize();
    const selected=app.getSnapshot().history[0]!;
    ui=render(React.createElement(App,{controller:app}));await delay(40);
    Object.defineProperties(ui.stdout,{isTTY:{value:true},columns:{value:110,configurable:true},rows:{value:38,configurable:true}});
    ui.stdout.emit('resize');await delay(40);
    const click=async(label:string)=>{
      const lines=ui!.frames.findLast(frame=>frame.includes('GPT-LIVE'))!.split('\n');
      const y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,label);
      const x=lines[y]!.indexOf(label)+1;
      ui!.stdin.write(`\u001b[<0;${x};${y+1}M`);ui!.stdin.write(`\u001b[<0;${x};${y+1}m`);await delay(70);
    };
    await click('3 ИСТОРИЯ');await click('УДАЛИТЬ ЗВОНОК');await click('УДАЛИТЬ НАВСЕГДА');
    assert.equal(app.getSnapshot().history.length,1);
    await assert.rejects(access(store.directory(selected.id)),{code:'ENOENT'});
    await assert.rejects(access(selected.recordingPath!),{code:'ENOENT'});
    assert.equal((await readdir('recordings')).length,1);
    const orphan=join('calls',randomUUID());await mkdir(orphan);await writeFile(join(orphan,'call.json'),'{interrupted');
    await writeFile(join('recordings',randomUUID()+'.wav'),Buffer.alloc(100));
    await mkdir('calls/manual-notes');await writeFile('calls/manual-notes/keep.txt','keep');
    await writeFile('recordings/manual-export.mp3','keep');
    await click('ОЧИСТИТЬ ИСТОРИЮ');await click('УДАЛИТЬ НАВСЕГДА');
    assert.deepEqual(app.getSnapshot().history,[]);
    assert.deepEqual(await readdir('calls'),['manual-notes']);assert.deepEqual(await readdir('recordings'),['manual-export.mp3']);
  }finally{ui?.unmount();await app?.close().catch(()=>{});process.chdir(previous);await rm(root,{recursive:true,force:true});}
});
