import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import React from 'react';
import {render as renderInk} from 'ink';
import {render} from 'ink-testing-library';
import {App} from '../src/ui.js';
import type {CallRecord, ConsoleController, Snapshot} from '../src/types.js';

const record: CallRecord = {
  id: 'call-1', direction: 'outbound', number: '+79990000000', task: 'Уточнить доставку',
  startedAt: '2026-11-07T10:00:00Z', status: 'completed', closeConfirmed: true,
  entries: [
    {role: 'human', text: 'Доставка завтра.', startMs: 1000, endMs: 2000},
    {role: 'agent', text: 'Спасибо, до свидания.', startMs: 2100, endMs: 3000},
  ], summary: 'Доставка подтверждена.',
};

type Rendered = ReturnType<typeof render>;
const screen = (ui: Rendered) => ui.frames.findLast(frame => frame.includes('GPT-LIVE'))!;
function point(ui: Rendered, label: string) {
  const lines = screen(ui).split('\n');
  const y = lines.findIndex(line => line.includes(label));
  assert.ok(y >= 0, `Visible mouse target: ${label}\n${screen(ui)}`);
  return {x: lines[y]!.indexOf(label) + 1, y: y + 1};
}
async function click(ui: Rendered, label: string) {
  const {x, y} = point(ui, label);
  ui.stdin.write(`\u001b[<0;${x};${y}M`);
  ui.stdin.write(`\u001b[<0;${x};${y}m`);
  await delay(35);
}
async function mouseConsole(controller: ConsoleController, columns = 100, rows = 40) {
  const ui = render(<App controller={controller} />);
  await delay(30);
  Object.defineProperties(ui.stdout, {isTTY: {value: true}, columns: {value: columns, configurable: true}, rows: {value: rows, configurable: true}});
  ui.stdout.emit('resize');
  await delay(30);
  return ui;
}

function fakeController(initial: Partial<Snapshot> = {}) {
  let snapshot: Snapshot = {mode: 'demo', gatewayStatus: 'disabled', configIssues: [], history: [], notice: 'Готово', ...initial};
  const listeners = new Set<() => void>();
  const actions: unknown[][] = [];
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = {...snapshot, ...patch};
    for (const listener of listeners) listener();
  };
  const controller: ConsoleController = {
    getSnapshot: () => snapshot,
    subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
    setMode: async mode => {actions.push(['mode', mode]); publish({mode});},
    startCall: async (number, task) => {
      actions.push(['start', number, task]);
      publish({current: {...record, status: 'active', entries: []}});
    },
    hangup: async () => {actions.push(['hangup']);},
    sendInstruction: async value => {actions.push(['instruction', value]);},
    summarize: async id => {actions.push(['summary', id]);},
    sendTranscript: async id => {actions.push(['transcript', id]);},
    playRecording: async (id,position=0) => {actions.push(['recording', id,position]);publish({playback:{id,positionSeconds:position,durationSeconds:120,paused:false}});},
    pauseRecording:async()=>{actions.push(['pause-recording']);if(snapshot.playback)publish({playback:{...snapshot.playback,paused:true}});},
    seekRecording:async position=>{actions.push(['seek-recording',position]);if(snapshot.playback)publish({playback:{...snapshot.playback,positionSeconds:Math.max(0,Math.min(120,position))}});},
    stopRecording:async()=>{actions.push(['stop-recording']);publish({playback:undefined});},
    deleteHistory:async id=>{actions.push(['delete-history',id]);publish({history:id?snapshot.history.filter(call=>call.id!==id):[],current:!id||snapshot.current?.id===id?undefined:snapshot.current});},
    copyOwnNumber:async()=>{actions.push(['copy-number']);},
    refreshOwnNumber:async()=>{actions.push(['refresh-number']);},
    doctor: async () => [{name: 'Телефония', ok: false, detail: 'Транк не настроен'}],
    close: async () => {actions.push(['close']);},
  };
  return {controller, actions, publish};
}

test('a number alone enables calling without a task',async()=>{
  const {controller,actions}=fakeController();const ui=await mouseConsole(controller);
  try{
    ui.stdin.write('+70000000000');await delay(30);await click(ui,'ПОЗВОНИТЬ');
    assert.deepEqual(actions,[['start','+70000000000','']]);
  }finally{ui.unmount();}
});

for(const columns of [110,56])test(`history deletion uses a modal, defaults to cancel and requires explicit mouse or keyboard confirmation at ${columns} columns`,async()=>{
  const {controller,actions}=fakeController({history:[record,{...record,id:'call-2',number:'+70000000001'}]});
  const ui=await mouseConsole(controller,columns,38);
  try{
    await click(ui,'3 ИСТОРИЯ');await click(ui,'УДАЛИТЬ ЗВОНОК');
    assert.match(screen(ui),/WAV.*JSON/u);assert.deepEqual(actions,[]);
    ui.stdin.write('\r');await delay(30);assert.deepEqual(actions,[]);assert.doesNotMatch(screen(ui),/УДАЛИТЬ НАВСЕГДА/);
    await click(ui,'УДАЛИТЬ ЗВОНОК');await click(ui,'УДАЛИТЬ НАВСЕГДА');
    assert.deepEqual(actions,[['delete-history','call-1']]);assert.match(screen(ui),/ИСТОРИЯ · 1/);
    await click(ui,'ОЧИСТИТЬ ИСТОРИЮ');ui.stdin.write('\u001b');
    for(let i=0;i<20&&screen(ui).includes('УДАЛИТЬ НАВСЕГДА');i++)await delay(10);
    assert.doesNotMatch(screen(ui),/УДАЛИТЬ НАВСЕГДА/);assert.equal(actions.length,1);
    await click(ui,'ОЧИСТИТЬ ИСТОРИЮ');ui.stdin.write('\t');await delay(30);ui.stdin.write('\r');await delay(40);
    assert.deepEqual(actions,[['delete-history','call-1'],['delete-history',undefined]]);assert.match(screen(ui),/ИСТОРИЯ · 0/);
  }finally{ui.unmount();}
});

test('a new incoming call dismisses deletion confirmation without deleting anything',async()=>{
  const {controller,actions,publish}=fakeController({history:[record]});const ui=await mouseConsole(controller,110,38);
  try{
    await click(ui,'3 ИСТОРИЯ');await click(ui,'ОЧИСТИТЬ ИСТОРИЮ');
    publish({current:{...record,id:'active-call',status:'active'}});await delay(40);
    assert.doesNotMatch(screen(ui),/УДАЛИТЬ НАВСЕГДА/);assert.deepEqual(actions,[]);
  }finally{ui.unmount();}
});

test('editing number and task never runs command hotkeys; focused call button starts once', async () => {
  const {controller, actions} = fakeController();
  const ui = render(<App controller={controller} />);
  await delay(30);
  assert.match(ui.lastFrame()!, /GPT-LIVE/);
  assert.match(ui.lastFrame()!, /DEMO/);
  ui.stdin.write('+79990000000');
  await delay(20);
  ui.stdin.write('\t');
  await delay(20);
  ui.stdin.write('q x d m s t h');
  await delay(20);
  assert.deepEqual(actions, []);
  assert.match(ui.lastFrame()!, /q x d m s t h/);
  ui.stdin.write('\r');
  await delay(20);
  assert.deepEqual(actions, []);
  ui.stdin.write('\t');
  await delay(20);
  ui.stdin.write('\r');
  await delay(40);
  assert.deepEqual(actions, [['start', '+79990000000', 'q x d m s t h']]);
  assert.match(ui.lastFrame()!, /В ЭФИРЕ/);
  ui.unmount();
});

test('history exposes role-separated transcript and explicit summary/export actions', async () => {
  const {controller, actions} = fakeController({history: [record]});
  const ui = render(<App controller={controller} />);
  await delay(30);
  ui.stdin.write('\u001b');
  await delay(20);
  ui.stdin.write('h');
  await delay(30);
  assert.match(ui.lastFrame()!, /ИСТОРИЯ/);
  assert.match(ui.lastFrame()!, /ЧЕЛОВЕК/);
  assert.match(ui.lastFrame()!, /Доставка завтра/);
  assert.match(ui.lastFrame()!, /АГЕНТ/);
  assert.match(ui.lastFrame()!, /Доставка подтверждена/);
  assert.deepEqual(actions, []);
  ui.stdin.write('s');
  await delay(30);
  ui.stdin.write('t');
  await delay(30);
  assert.deepEqual(actions, [['summary', 'call-1'], ['transcript', 'call-1']]);
  ui.unmount();
});

test('command mode displays diagnostics and switches live/demo without dialling', async () => {
  const {controller, actions} = fakeController();
  const ui = render(<App controller={controller} />);
  await delay(30);
  ui.stdin.write('\u001b');
  await delay(20);
  ui.stdin.write('d');
  await delay(40);
  assert.match(ui.lastFrame()!, /Транк не настроен/);
  ui.stdin.write('m');
  await delay(30);
  assert.match(ui.lastFrame()!, /LIVE/);
  assert.deepEqual(actions, [['mode', 'live']]);
  ui.unmount();
});

test('recording modal pauses, seeks by keys and timeline, blocks background and closes with Escape', async()=>{
  const {controller,actions}=fakeController({history:[{...record,recordingPath:'C:/recordings/test.wav'}]});
  const ui=await mouseConsole(controller);await click(ui,'3 ИСТОРИЯ');const background=point(ui,'1 НОВЫЙ');
  try{
    assert.deepEqual(actions,[]);await click(ui,'a СЛУШАТЬ');assert.deepEqual(actions,[['recording','call-1',0]]);assert.match(screen(ui),/GPT-LIVE \/ ПЛЕЕР/);assert.match(screen(ui),/0:00 \/ 2:00/);
    ui.stdin.write(`\u001b[<0;${background.x};${background.y}M`);await delay(25);assert.deepEqual(actions,[['recording','call-1',0]]);
    ui.stdin.write(' ');await delay(25);assert.match(screen(ui),/ПРОДОЛЖИТЬ/);ui.stdin.write('\u001b[C');await delay(25);assert.match(screen(ui),/0:10 \/ 2:00/);
    const line=screen(ui).split('\n').findIndex(row=>/[●━─]{8}/u.test(row));assert.ok(line>=0);const row=screen(ui).split('\n')[line]!;const first=row.search(/[●━─]/u),last=Math.max(row.lastIndexOf('─'),row.lastIndexOf('━'),row.lastIndexOf('●'));
    ui.stdin.write(`\u001b[<0;${last+1};${line+1}M`);await delay(30);assert.match(screen(ui),/2:00 \/ 2:00/);
    ui.stdin.write('\u001b[H');await delay(25);assert.match(screen(ui),/0:00 \/ 2:00/);await click(ui,'ПРОДОЛЖИТЬ');assert.deepEqual(actions.at(-1),['recording','call-1',0]);
    ui.stdin.write('\u001b');await delay(45);assert.deepEqual(actions.at(-1),['stop-recording']);assert.doesNotMatch(screen(ui),/GPT-LIVE \/ ПЛЕЕР/);assert.ok(first>=0);
  }finally{ui.unmount();}
});

for(const columns of [56,100])test(`recording modal stays in place during seeking, pause and errors at ${columns} columns`,async()=>{
  const {controller}=fakeController({history:[{...record,recordingPath:'C:/recordings/test.wav'}]});
  let finishSeek!:()=>void;const seek=controller.seekRecording;
  controller.seekRecording=async position=>{await new Promise<void>(resolve=>{finishSeek=resolve;});await seek(position);};
  const ui=await mouseConsole(controller,columns,30);
  const geometry=()=>{
    const lines=screen(ui).split('\n');const top=lines.findIndex(line=>line.includes('╔')),bottom=lines.findIndex(line=>line.includes('╚'));
    assert.ok(top>=0&&bottom>top);return {top,bottom,left:lines[top]!.indexOf('╔'),forward:point(ui,'+10 сек')};
  };
  try{
    await click(ui,'3 ИСТОРИЯ');await click(ui,'a СЛУШАТЬ');const before=geometry();
    await click(ui,'+10 сек');assert.match(screen(ui),/Перематываем/);assert.deepEqual(geometry(),before);
    finishSeek();await delay(35);assert.deepEqual(geometry(),before);assert.match(screen(ui),/0:10 \/ 2:00/);
    await click(ui,'ПАУЗА');assert.match(screen(ui),/ПРОДОЛЖИТЬ/);assert.deepEqual(geometry(),before);
    controller.seekRecording=async()=>{throw new Error('Не удалось перемотать запись. '.repeat(12));};
    await click(ui,'+10 сек');assert.match(screen(ui),/Не удалось перемотать/);assert.deepEqual(geometry(),before);
  }finally{finishSeek?.();await delay(25);ui.unmount();}
});

test('audio can be stopped while a summary is still pending',async()=>{
  const {controller,actions}=fakeController({history:[record],playback:{id:record.id,positionSeconds:0,durationSeconds:120,paused:false}});
  let finish!:()=>void;controller.summarize=()=>new Promise<void>(resolve=>{finish=resolve;});
  const ui=await mouseConsole(controller,110,38);
  try{await click(ui,'3 ИСТОРИЯ');await click(ui,'s ИТОГ');await click(ui,'■ СТОП');assert.deepEqual(actions,[['stop-recording']]);}
  finally{finish?.();await delay(25);ui.unmount();}
});

test('an active call receives typed steering only after the send button and hangup stays explicit', async () => {
  const {controller, actions} = fakeController({current: {...record, status: 'active'}});
  const ui = render(<App controller={controller} />);
  await delay(40);
  ui.stdin.write('x q h m уточни адрес');
  await delay(20);
  assert.deepEqual(actions, []);
  ui.stdin.write('\t');
  await delay(20);
  ui.stdin.write('\r');
  await delay(30);
  assert.deepEqual(actions, [['instruction', 'x q h m уточни адрес']]);
  ui.stdin.write('\t');
  await delay(20);
  ui.stdin.write('\r');
  await delay(30);
  assert.deepEqual(actions, [['instruction', 'x q h m уточни адрес'], ['hangup']]);
  ui.unmount();
});

test('quit awaits closing the controller before unmounting and ignores repeated quit', async () => {
  const {controller, actions} = fakeController();
  let finishClose!: () => void;
  controller.close = () => {actions.push(['close']); return new Promise<void>(resolve => {finishClose = resolve;});};
  const ui = render(<App controller={controller} />);
  await delay(30);
  ui.stdin.write('\u001b');
  await delay(20);
  ui.stdin.write('q');
  await delay(30);
  assert.match(ui.lastFrame()!, /Закрываем соединения/);
  assert.deepEqual(actions, [['close']]);
  ui.stdin.write('q');
  await delay(20);
  assert.deepEqual(actions, [['close']]);
  finishClose();
  await delay(30);
  assert.equal(ui.stdin.listenerCount('readable'), 0);
  ui.unmount();
});

test('narrow terminal keeps the form usable and live updates refresh the transcript', async () => {
  const {controller, publish} = fakeController();
  const ui = render(<App controller={controller} />);
  await delay(30);
  Object.defineProperty(ui.stdout, 'columns', {value: 56});
  ui.stdout.emit('resize');
  await delay(30);
  assert.match(ui.lastFrame()!, /ПОЗВОНИТЬ/);
  assert.ok(ui.lastFrame()!.split('\n').every(line => [...line].length <= 56));
  publish({current: {...record, status: 'active'}});
  await delay(30);
  assert.match(ui.lastFrame()!, /В ЭФИРЕ/);
  assert.match(ui.lastFrame()!, /Доставка завтра/);
  ui.unmount();
});

test('without raw terminal input the console renders a readable fallback', async () => {
  const {controller} = fakeController();
  const stdout = Object.assign(new PassThrough(), {columns: 80, rows: 24});
  let output = '';
  stdout.on('data', value => {output += String(value);});
  const ui = renderInk(<App controller={controller} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await delay(40);
  assert.match(output, /Нет интерактивного ввода/);
  assert.match(output, /ПОЗВОНИТЬ/);
  assert.doesNotMatch(output, /Raw mode is not supported/);
  ui.unmount();
});

for (const cancel of ['command', 'button', 'quit'] as const) {
  test(`a pending dial can be cancelled with the ${cancel} before startCall resolves`, async () => {
    const {controller, actions, publish} = fakeController();
    let finishDial!: () => void;
    controller.startCall = async (number, task) => {
      actions.push(['start', number, task]);
      publish({current: {...record, status: 'ringing', entries: []}});
      await new Promise<void>(resolve => {finishDial = resolve;});
    };
    const ui = render(<App controller={controller} />);
    await delay(30);
    ui.stdin.write('+79990000000');
    await delay(20);
    ui.stdin.write('\t');
    await delay(20);
    ui.stdin.write('Уточни доставку');
    await delay(20);
    ui.stdin.write('\t');
    await delay(20);
    ui.stdin.write('\r');
    await delay(30);
    assert.match(ui.lastFrame()!, /ОЖИДАНИЕ/);
    if (cancel !== 'button') {
      ui.stdin.write('\u001b');
      await delay(20);
      ui.stdin.write('s');
      await delay(20);
      ui.stdin.write(cancel === 'quit' ? 'q' : 'x');
    } else {
      ui.stdin.write('\t');
      await delay(20);
      ui.stdin.write('\r');
    }
    await delay(30);
    assert.deepEqual(actions, [['start', '+79990000000', 'Уточни доставку'], [cancel === 'quit' ? 'close' : 'hangup']]);
    finishDial();
    await delay(20);
    ui.unmount();
  });
}

test('mouse tabs and history rows select measured targets and reporting is restored on unmount', async () => {
  const second = {...record, id: 'call-2', number: '+79991111111', task: 'Вторая задача'};
  const {controller, actions} = fakeController({history: [record, second]});
  const ui = await mouseConsole(controller);
  assert.ok(ui.frames.join('').includes('\u001b[?1002h\u001b[?1006h'));
  await click(ui, '3 ИСТОРИЯ');
  assert.match(screen(ui), /Доставка подтверждена/);
  await click(ui, '+79991111111');
  assert.match(screen(ui), /Задача: Вторая задача/);
  await click(ui, 's ИТОГ');
  await click(ui, 't ТРАНСКРИПТ');
  await click(ui, '4 ПРОВЕРКА');
  assert.match(screen(ui), /Транк не настроен/);
  assert.deepEqual(actions, [['summary', 'call-2'], ['transcript', 'call-2']]);
  ui.unmount();
  await delay(20);
  assert.ok(ui.frames.join('').includes('\u001b[?1002l\u001b[?1006l'));
});

for (const columns of [100, 56]) test(`mouse focuses fields and only the actual call button dials at ${columns} columns`, async () => {
  const {controller, actions} = fakeController();
  const ui = await mouseConsole(controller, columns);
  await click(ui, 'Можно оставить');
  ui.stdin.write('Уточни доставку');
  await delay(25);
  await click(ui, '+79991234567');
  ui.stdin.write('+79990000000');
  await delay(25);
  const button = point(ui, 'ПОЗВОНИТЬ');
  ui.stdin.write(`\u001b[<0;${columns - 3};${button.y}M`);
  await delay(25);
  assert.deepEqual(actions, []);
  assert.doesNotMatch(screen(ui), /\[<0;/);
  await click(ui, 'ПОЗВОНИТЬ');
  assert.deepEqual(actions, [['start', '+79990000000', 'Уточни доставку']]);
  ui.unmount();
});

test('Escape command navigation still works when mouse input is enabled', async () => {
  const {controller} = fakeController({history: [record]});
  const ui = await mouseConsole(controller);
  ui.stdin.write('\u001b');
  await delay(25);
  ui.stdin.write('h');
  await delay(35);
  assert.match(screen(ui), /Доставка подтверждена/);
  ui.unmount();
});

test('mouse coordinates follow the visible bottom of a frame on short terminals', async () => {
  const {controller, actions} = fakeController();
  const ui = await mouseConsole(controller);
  await click(ui, 'Можно оставить');
  ui.stdin.write('Уточни доставку');
  await delay(25);
  await click(ui, '+79991234567');
  ui.stdin.write('+79990000000');
  await delay(25);
  Object.defineProperty(ui.stdout, 'rows', {value: 12});
  ui.stdout.emit('resize');
  await delay(30);
  const button = point(ui, 'ПОЗВОНИТЬ');
  const scroll = screen(ui).split('\n').length - 12;
  const y = button.y - scroll;
  assert.ok(y > 0 && y <= 12);
  ui.stdin.write(`\u001b[<0;${button.x};${y}M`);
  await delay(35);
  assert.deepEqual(actions, [['start', '+79990000000', 'Уточни доставку']]);
  ui.unmount();
});

test('the Windows alternate-screen frame starts at the viewport origin after launcher output',async()=>{
  const {controller}=fakeController();const stdin=new PassThrough(),stdout=new PassThrough();let output='';
  Object.assign(stdin,{isTTY:true,setRawMode:()=>stdin,ref:()=>stdin,unref:()=>stdin});Object.assign(stdout,{isTTY:true,columns:110,rows:35});stdout.on('data',b=>output+=b);
  const app=renderInk(<App controller={controller}/>,{stdin:stdin as any,stdout:stdout as any,stderr:stdout as any,interactive:true,alternateScreen:true,patchConsole:false});
  try{await delay(50);const marker=output.indexOf('GPT-LIVE');assert.ok(marker>=0);assert.match(output.slice(0,marker),/\u001b\[1;1H/);}
  finally{app.unmount();}
});

test('Ctrl arrows switch tabs while a text field is focused without editing or dialling',async()=>{
  const {controller,actions}=fakeController({history:[record]});const ui=render(<App controller={controller}/>);
  try{await delay(30);ui.stdin.write('\u001b[1;5C');await delay(30);assert.match(ui.lastFrame()!,/Звонков пока нет/);ui.stdin.write('\u001b[1;5C');await delay(30);assert.match(ui.lastFrame()!,/Доставка подтверждена/);ui.stdin.write('\u001b[1;5D');await delay(30);assert.match(ui.lastFrame()!,/Звонков пока нет/);assert.deepEqual(actions,[]);}
  finally{ui.unmount();}
});

test('the incoming number is visible and copies only on an explicit click or command',async()=>{
  const {controller,actions}=fakeController({ownNumber:'+70000000000',ownNumberSource:'api'});const ui=await mouseConsole(controller);
  try{assert.match(screen(ui),/\+70000000000/);assert.match(screen(ui),/Плюсофон API/);assert.deepEqual(actions,[]);await click(ui,'КОПИРОВАТЬ');assert.deepEqual(actions,[['copy-number']]);ui.stdin.write('\u001b');await delay(30);ui.stdin.write('b');await delay(30);assert.deepEqual(actions,[['copy-number'],['copy-number']]);}
  finally{ui.unmount();}
});

test('a long single reply scrolls by lines with the wheel and Page keys while tabs and actions stay visible',async()=>{
  const long={...record,task:'Длинный разговор',entries:[{role:'agent' as const,startMs:0,endMs:1000,text:Array.from({length:60},(_,n)=>`LINE_${String(n).padStart(3,'0')} ${'слово '.repeat(10)}`).join(' ')}]};
  const {controller,actions}=fakeController({current:long,history:[long]});const ui=await mouseConsole(controller,100,30);
  try{
    ui.stdin.write('\u001b[1;5C');await delay(50);assert.match(screen(ui),/LINE_059/);assert.doesNotMatch(screen(ui),/LINE_000/);assert.ok(screen(ui).split('\n').length<=30);assert.match(screen(ui),/1 НОВЫЙ/);assert.match(screen(ui),/s ИТОГ/);
    const lines=screen(ui).split('\n'),index=lines.findLastIndex(l=>l.includes('LINE_'));const x=lines[index]!.indexOf('LINE_')+1;
    ui.stdin.write(`\u001b[<64;${x};${index+1}M`);await delay(40);assert.doesNotMatch(screen(ui),/LINE_059/);
    ui.stdin.write('\u001b[1;5H');await delay(40);assert.match(screen(ui),/LINE_000/);ui.stdin.write('\u001b[6~');await delay(40);assert.doesNotMatch(screen(ui),/LINE_000/);
    await click(ui,'В КОНЕЦ');assert.match(screen(ui),/LINE_059/);await click(ui,'s ИТОГ');assert.deepEqual(actions,[['summary','call-1']]);
  }finally{ui.unmount();}
});

test('live replies follow the bottom until the reader scrolls up, and Ctrl End resumes following',async()=>{
  const entry=(n:number)=>({role:'agent' as const,text:`TURN_${String(n).padStart(3,'0')} ${'речь '.repeat(12)}`,startMs:n*1000,endMs:n*1000+900});
  const call={...record,status:'active' as const,entries:Array.from({length:40},(_,n)=>entry(n))};const {controller,publish}=fakeController({current:call});const ui=await mouseConsole(controller,100,30);
  try{
    assert.match(screen(ui),/TURN_039/);ui.stdin.write('\u001b[5~');await delay(40);const before=screen(ui);assert.doesNotMatch(before,/TURN_039/);
    publish({current:{...call,entries:[...call.entries,entry(40)]}});await delay(40);assert.doesNotMatch(screen(ui),/TURN_040/);assert.match(screen(ui),/ЗАВЕРШИТЬ ЗВОНОК/);
    ui.stdin.write('\u001b[1;5F');await delay(40);assert.match(screen(ui),/TURN_040/);publish({current:{...call,entries:[...call.entries,entry(40),entry(41)]}});await delay(40);assert.match(screen(ui),/TURN_041/);
    Object.defineProperty(ui.stdout,'rows',{value:24,configurable:true});ui.stdout.emit('resize');await delay(40);assert.match(screen(ui),/TURN_041/);assert.match(screen(ui),/1 НОВЫЙ/);assert.ok(screen(ui).split('\n').length<=24);
  }finally{ui.unmount();}
});

test('the vertical scrollbar shows the visible fraction and position and jumps on track clicks',async()=>{
  const call={...record,entries:Array.from({length:60},(_,n)=>({role:'agent' as const,text:`SCROLL_${String(n).padStart(3,'0')} ${'текст '.repeat(8)}`,startMs:n*1000,endMs:n*1000+900}))};
  const {controller,actions}=fakeController({current:call});const ui=await mouseConsole(controller,100,30);
  const bar=()=>screen(ui).split('\n').map((line,y)=>({line,y})).filter(row=>/[░█]/.test(row.line));
  try{
    ui.stdin.write('\u001b[1;5C');await delay(50);let rows=bar();assert.ok(rows.length>3);assert.ok(rows.filter(row=>row.line.includes('█')).length<rows.length);assert.match(rows.at(-1)!.line,/█/);assert.match(screen(ui),/100%/);
    ui.stdin.write('\u001b[1;5H');await delay(40);rows=bar();assert.match(rows[0]!.line,/█/);assert.doesNotMatch(rows.at(-1)!.line,/█/);assert.match(screen(ui),/0%/);
    const last=rows.at(-1)!;const x=Math.max(last.line.lastIndexOf('░'),last.line.lastIndexOf('█'))+1;ui.stdin.write(`\u001b[<0;${x};${last.y+1}M`);await delay(40);assert.match(screen(ui),/SCROLL_059/);assert.match(screen(ui),/100%/);assert.deepEqual(actions,[]);
    ui.stdin.write(`\u001b[<64;${x};${last.y+1}M`);await delay(40);assert.doesNotMatch(screen(ui),/100%/);assert.match(screen(ui),/1 НОВЫЙ/);
  }finally{ui.unmount();}
});

test('the whole scrollbar hit area jumps even when clicking its thumb',async()=>{
  const call={...record,entries:Array.from({length:14},(_,n)=>({role:'agent' as const,text:`CLICK_${String(n).padStart(3,'0')} ${'текст '.repeat(8)}`,startMs:n*1000,endMs:n*1000+900}))};
  const {controller,actions}=fakeController({current:call});const ui=await mouseConsole(controller,100,30);
  const bar=()=>screen(ui).split('\n').map((line,y)=>({line,y})).filter(row=>/[░█]/.test(row.line));
  const press=async(row:{line:string;y:number},padding=false)=>{const x=Math.max(row.line.lastIndexOf('░'),row.line.lastIndexOf('█'))+1-(padding?1:0);ui.stdin.write(`\u001b[<0;${x};${row.y+1}M\u001b[<0;${x};${row.y+1}m`);await delay(40);};
  try{
    ui.stdin.write('\u001b[1;5C');await delay(50);assert.match(screen(ui),/100%/);
    await press(bar()[0]!,true);assert.match(screen(ui),/· 0%/);assert.match(screen(ui),/CLICK_000/);
    const thumb=bar().filter(row=>row.line.includes('█'));assert.ok(thumb.length>1);await press(thumb[1]!);assert.doesNotMatch(screen(ui),/· 0%/);
    await press(bar().at(-1)!,true);assert.match(screen(ui),/100%/);assert.match(screen(ui),/CLICK_013/);assert.deepEqual(actions,[]);
  }finally{ui.unmount();}
});

test('the scrollbar thumb drags without jumping on grab and releases capture outside its track',async()=>{
  const call={...record,entries:Array.from({length:30},(_,n)=>({role:'agent' as const,text:`DRAG_${String(n).padStart(3,'0')} ${'текст '.repeat(8)}`,startMs:n*1000,endMs:n*1000+900}))};
  const {controller,actions}=fakeController({current:call});const ui=await mouseConsole(controller,100,30);
  const bar=()=>screen(ui).split('\n').map((line,y)=>({line,y})).filter(row=>/[░█]/.test(row.line));
  try{
    ui.stdin.write('\u001b[1;5C');await delay(40);ui.stdin.write('\u001b[1;5H');await delay(40);let rows=bar();const x=rows[0]!.line.indexOf('█')+1,grab=rows[1]!.y+1;
    ui.stdin.write(`\u001b[<0;${x};${grab}M`);await delay(30);assert.match(screen(ui),/· 0%/);
    const end=rows.at(-1)!.y+1;ui.stdin.write(`\u001b[<32;${x-8};${end}M`);await delay(40);assert.match(screen(ui),/100%/);assert.match(screen(ui),/DRAG_029/);
    ui.stdin.write(`\u001b[<32;${x-8};${grab}M`);await delay(40);assert.match(screen(ui),/· 0%/);
    ui.stdin.write(`\u001b[<0;${x-8};${grab}m`);await delay(20);ui.stdin.write(`\u001b[<32;${x};${end}M`);await delay(40);assert.match(screen(ui),/· 0%/);assert.deepEqual(actions,[]);
  }finally{ui.unmount();}
});

test('the scrollbar stays hidden when the entire conversation fits',async()=>{
  const {controller}=fakeController({current:record});const ui=await mouseConsole(controller,100,40);
  try{ui.stdin.write('\u001b[1;5C');await delay(40);assert.match(screen(ui),/Доставка завтра/);assert.doesNotMatch(screen(ui),/[░█]/);}
  finally{ui.unmount();}
});
