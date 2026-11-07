import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, measureElement, useBoxMetrics, useApp, useInput, useStdin, useWindowSize, type DOMElement} from 'ink';
import TextInput from 'ink-text-input';
import type {CallRecord, Check, ConsoleController} from './types.js';
import {useMouse, type MouseTargets} from './mouse.js';

const teal = '#55D6BE';
const amber = '#F2BD62';
const statusNames = {
  dialing: 'НАБОР', ringing: 'ОЖИДАНИЕ', active: 'В ЭФИРЕ', ending: 'ЗАВЕРШЕНИЕ',
  completed: 'ЗАВЕРШЁН', failed: 'ОШИБКА',
};
type View = 'compose' | 'call' | 'history' | 'doctor';
type Field = 'number' | 'task' | 'start' | 'instruction' | 'send' | 'hangup';

// Transcripts and gateway errors must never execute terminal control sequences.
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const isOngoing = (call?: CallRecord) => Boolean(call && !['completed', 'failed'].includes(call.status));
const stamp = (milliseconds: number) => `${Math.floor(milliseconds / 60_000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}`;
const time = (date: string) => {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
};

function Button({children, focused, disabled = false, elementRef}: {children: React.ReactNode; focused: boolean; disabled?: boolean; elementRef?: (node: DOMElement | null) => void}) {
  return <Box ref={elementRef} flexShrink={0} aria-role="button" aria-state={{disabled}}><Text color={disabled ? 'gray' : focused ? 'black' : teal} backgroundColor={focused && !disabled ? teal : undefined} bold={focused}> {focused ? '›' : ' '} {children} </Text></Box>;
}

function Transcript({call}: {call: CallRecord}) {
  return <Box flexDirection="column" gap={1}>
    {call.entries.length ? call.entries.map((entry, index) => <Box key={index} flexDirection="column">
      <Text color={entry.role === 'human' ? amber : teal} bold>{entry.role === 'human' ? 'ЧЕЛОВЕК' : 'АГЕНТ'} <Text dimColor>{stamp(entry.startMs)}</Text></Text>
      <Text wrap="wrap">{clean(entry.text)}</Text>
    </Box>) : <Text dimColor>Реплики появятся здесь во время разговора.</Text>}
  </Box>;
}

export function App({controller}: {controller: ConsoleController}) {
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const [view, setView] = useState<View>('compose');
  const [field, setField] = useState<Field>('number');
  const [commands, setCommands] = useState(false);
  const commandsRef = useRef(false);
  const [number, setNumber] = useState('');
  const [task, setTask] = useState('');
  const [instruction, setInstruction] = useState('');
  const [selection, setSelection] = useState(0);
  const [offset, setOffset] = useState<number|null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const working = useRef(false);
  const stopping = useRef(false);
  const closing = useRef(false);
  const root = useRef<DOMElement>(null);
  const viewport=useRef<DOMElement>(null),content=useRef<DOMElement>(null),scrollArea=useRef<DOMElement>(null);
  const viewportMetrics=useBoxMetrics(viewport),contentMetrics=useBoxMetrics(content);
  const targets = useRef<MouseTargets>(new Map());
  useMouse(root, targets, () => commandMode(true),(direction,x,y)=>{
    if(!scrollArea.current)return;const box=measureElement(scrollArea.current);
    if(x>=box.x&&x<box.x+box.width&&y>=box.y&&y<box.y+box.height)scrollBy(direction*3);
  });
  const {exit} = useApp();
  const {isRawModeSupported} = useStdin();
  const {columns, rows} = useWindowSize();
  const width = columns || 80;
  const wide = width >= 96;
  const active = isOngoing(snapshot.current);
  const selected = view === 'history' ? snapshot.history[Math.min(selection, snapshot.history.length - 1)] : snapshot.current;
  const scrollingView=view==='call'||view==='history';
  const maxOffset=Math.max(0,contentMetrics.height-viewportMetrics.clientHeight);
  const scrollTop=offset===null?maxOffset:Math.min(offset,maxOffset);
  const trackHeight=Math.max(0,Math.floor(viewportMetrics.clientHeight));
  const thumbHeight=Math.min(trackHeight,Math.max(1,Math.round(trackHeight*trackHeight/Math.max(1,contentMetrics.height))));
  const thumbTop=maxOffset?Math.round((trackHeight-thumbHeight)*scrollTop/maxOffset):0;
  const scrollPercent=maxOffset?Math.round(scrollTop/maxOffset*100):100;
  const canStart = Boolean(number.trim() && task.trim() && !active && !busy && !cancelling);

  function scrollBy(lines:number){setOffset(previous=>{
    const next=Math.max(0,Math.min(maxOffset,(previous===null?maxOffset:Math.min(previous,maxOffset))+lines));
    return next===maxOffset?null:next;
  });}

  function commandMode(value: boolean) {
    commandsRef.current = value;
    setCommands(value);
  }

  useEffect(() => {
    const update = () => setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(update);
    update();
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    if (snapshot.current && isOngoing(snapshot.current)) {
      setView('call');
      setField('instruction');
      setOffset(null);
    }
  }, [snapshot.current?.id]);

  async function run(label: string, action: () => Promise<void>) {
    if (working.current || stopping.current || closing.current) return;
    working.current = true;
    setBusy(label);
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setBusy(''); }
  }

  async function hangup() {
    if (!active || stopping.current || closing.current) return;
    stopping.current = true;
    setCancelling(true);
    setError('');
    try { await controller.hangup(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { stopping.current = false; setCancelling(false); }
  }

  async function quit() {
    if (closing.current) return;
    closing.current = true;
    setBusy('Закрываем соединения…');
    try { await controller.close(); exit(); }
    catch (cause) {
      closing.current = false;
      setBusy('');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const show = (next: View) => {setView(next); setOffset(null);};
  const focus = (name: Field) => {setField(name); commandMode(false);};
  const target = (id: string, press: () => void) => (node: DOMElement | null) => {
    if (node) targets.current.set(id, {node, press});
    else targets.current.delete(id);
  };
  const navigate = (next: View) => {
    show(next);
    if (next === 'compose') focus('number');
    else if (next === 'call') focus('instruction');
    else commandMode(true);
    if (next === 'doctor') void run('Проверяем…', async () => setChecks(await controller.doctor()));
  };
  const start = () => {
    if (canStart) void run('Соединяем…', () => controller.startCall(number.trim(), task.trim()));
  };
  const steer = () => {
    if (instruction.trim() && active) void run('Передаём инструкцию…', async () => {
      await controller.sendInstruction(instruction.trim());
      setInstruction('');
    });
  };

  useInput((input, key) => {
    const commands = commandsRef.current;
    if(key.ctrl&&(key.leftArrow||key.rightArrow)){
      const views:View[]=['compose','call','history','doctor'];navigate(views[(views.indexOf(view)+(key.rightArrow?1:3))%4]!);return;
    }
    if (key.ctrl && input === 'c') {void quit(); return;}
    if (key.escape) {commandMode(true); return;}
    if(scrollingView&&selected){
      if(key.pageUp||key.pageDown){scrollBy((key.pageDown?1:-1)*Math.max(1,viewportMetrics.clientHeight-1));return;}
      if((key.ctrl||commands)&&key.home){setOffset(0);return;}
      if((key.ctrl||commands)&&key.end){setOffset(null);return;}
    }
    if (commands && input === 'q') {void quit(); return;}
    if(commands&&input==='b'){void run('Копируем номер…',()=>controller.copyOwnNumber());return;}
    if (commands && input === 'x') {void hangup(); return;}
    if (!commands && key.return && field === 'hangup' && view === 'call') {void hangup(); return;}
    if (busy || cancelling) {
      if (key.tab && view === 'call' && active) {setField('hangup'); commandMode(false);}
      return;
    }
    if (key.tab) {
      if (view === 'compose' || (view === 'call' && active)) {
        const fields: Field[] = view === 'compose' ? ['number', 'task', 'start'] : ['instruction', 'send', 'hangup'];
        const position = commands ? (key.shift ? 0 : -1) : fields.indexOf(field);
        setField(fields[(position + (key.shift ? -1 : 1) + fields.length) % fields.length]!);
        commandMode(false);
      }
      return;
    }
    if (!commands) {
      if (key.return && field === 'start' && view === 'compose') start();
      if (key.return && field === 'send' && view === 'call') steer();
      return;
    }
    if (key.return) {commandMode(false); setField(view === 'call' ? 'instruction' : 'number'); return;}
    if (key.upArrow && view === 'history') {setSelection(value => Math.max(0, value - 1)); setOffset(null);}
    if (key.downArrow && view === 'history') {setSelection(value => Math.min(Math.max(0, snapshot.history.length - 1), value + 1)); setOffset(null);}
    if (input === 'n' || input === '1') {show('compose'); setField('number'); commandMode(false);}
    if (input === 'c' || input === '2') {show('call'); setField('instruction'); commandMode(false);}
    if (input === 'h' || input === '3') show('history');
    if (input === 'd' || input === '4') {
      show('doctor');
      void run('Проверяем…', async () => setChecks(await controller.doctor()));
    }
    if (input === 'm') void run('Меняем режим…', () => controller.setMode(snapshot.mode === 'demo' ? 'live' : 'demo'));
    if (input === 's' && selected) void run('Готовим итог…', () => controller.summarize(selected.id));
    if (input === 't' && selected) void run('Отправляем транскрипт…', () => controller.sendTranscript(selected.id));
    if (input === 'a' && selected && !isOngoing(selected)) void run('Открываем запись…', () => controller.playRecording(selected.id));
  }, {isActive: isRawModeSupported});

  const input = (name: Field, value: string, onChange: (value: string) => void, placeholder: string) => (
    isRawModeSupported ? <TextInput value={value} onChange={next => {if (!commandsRef.current) onChange(clean(next));}} placeholder={placeholder} focus={!commands && field === name && !busy && !cancelling} />
      : <Text>{value || placeholder}</Text>
  );

  const details = selected ? <Box flexDirection="column" flexGrow={1} minHeight={0}>
    <Box ref={scrollArea} flexDirection="row" flexGrow={1} minHeight={1}>
    <Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden" contentOffsetY={scrollTop}>
    <Box ref={content} flexDirection="column" flexShrink={0}>
    <Text color={teal} bold>{statusNames[selected.status]} <Text color="white">{clean(selected.number)}</Text> <Text dimColor>· {time(selected.startedAt)}</Text></Text>
    <Text wrap="wrap"><Text color={amber}>Задача: </Text>{clean(selected.task)}</Text>
    <Transcript call={selected} />
    {selected.summary && <Text wrap="wrap"><Text color={amber} bold>ИТОГ · </Text>{clean(selected.summary)}</Text>}
    {selected.error && <Text color="red">{clean(selected.error)}</Text>}
    {selected.savedPath && <Text dimColor wrap="truncate-end">Сохранено: {clean(selected.savedPath)}</Text>}
    </Box>
    </Box>
    <Box flexDirection="column" flexShrink={0} width={1} marginLeft={1} height={trackHeight} aria-label={`Прокрутка диалога: ${scrollPercent}%`}>
      {maxOffset>0&&Array.from({length:trackHeight},(_,row)=>{
        const thumb=row>=thumbTop&&row<thumbTop+thumbHeight;
        return <Box key={row} height={1} flexShrink={0} ref={target(`scrollbar-${row}`,()=>{
          if(thumb)return;const next=Math.round(maxOffset*row/Math.max(1,trackHeight-1));setOffset(next===maxOffset?null:next);
        })}><Text color={thumb?teal:'gray'}>{thumb?'█':'░'}</Text></Box>;
      })}
    </Box>
    </Box>
    {maxOffset>0&&<Box flexShrink={0} justifyContent="space-between">
      <Text dimColor wrap="truncate-end">Строки {scrollTop+1}–{Math.min(contentMetrics.height,scrollTop+viewportMetrics.clientHeight)} из {contentMetrics.height} · {scrollPercent}% · {offset===null?'Авто':'Просмотр'}</Text>
      <Button elementRef={target('scroll-end',()=>setOffset(null))} focused={false}>В КОНЕЦ</Button>
    </Box>}
    <Box gap={1} flexShrink={0}>
      <Button elementRef={target('summary', () => {void run('Готовим итог…', () => controller.summarize(selected.id));})} focused={false} disabled={Boolean(busy) || cancelling}>s ИТОГ</Button>
      <Button elementRef={target('transcript', () => {void run('Отправляем транскрипт…', () => controller.sendTranscript(selected.id));})} focused={false} disabled={Boolean(busy) || cancelling}>t ТРАНСКРИПТ</Button>
      {selected.recordingPath&&!isOngoing(selected)&&<Button elementRef={target('recording',()=>{void run('Открываем запись…',()=>controller.playRecording(selected.id));})} focused={false} disabled={Boolean(busy)||cancelling}>a ЗАПИСЬ</Button>}
    </Box>
  </Box> : <Text dimColor>Звонков пока нет. Нажмите Esc → n, чтобы начать.</Text>;

  return <Box ref={root} width={width} height={scrollingView?(rows||24):undefined} minHeight={rows || 24} flexDirection="column" paddingX={1}>
    <Box flexDirection="column" flexShrink={0}>
    <Box justifyContent="space-between">
      <Text bold color={teal}>◉ GPT-LIVE <Text color="white">/ PHONE</Text></Text>
      <Box gap={2}>
        <Box ref={target('mode', () => {void run('Меняем режим…', () => controller.setMode(snapshot.mode === 'demo' ? 'live' : 'demo'));})}><Text color={snapshot.mode === 'demo' ? amber : teal} bold>{snapshot.mode === 'demo' ? 'DEMO' : 'LIVE'} <Text dimColor>· {commands ? 'КОМАНДЫ' : 'ВВОД'}</Text></Text></Box>
        <Box ref={target('quit', () => {void quit();})}><Text dimColor>× ВЫХОД</Text></Box>
      </Box>
    </Box>
    <Text dimColor>{snapshot.mode === 'demo' ? 'Локальный прогон · без реальных звонков' : 'Телефонный пульт · исходящие и входящие'}</Text>
    {snapshot.ownNumber&&<Box flexWrap="wrap" columnGap={1}>
      <Text color={teal}>Входящий: {clean(snapshot.ownNumber)}</Text>
      <Text dimColor>{snapshot.ownNumberSource==='api'?'Плюсофон API':'из настроек'}</Text>
      <Button elementRef={target('copy-number',()=>{void run('Копируем номер…',()=>controller.copyOwnNumber());})} focused={false}>КОПИРОВАТЬ</Button>
      <Button elementRef={target('refresh-number',()=>{void run('Обновляем номер…',()=>controller.refreshOwnNumber());})} focused={false}>ОБНОВИТЬ</Button>
    </Box>}
    {snapshot.ownNumberError&&<Text color={amber} wrap="wrap">{clean(snapshot.ownNumberError)}</Text>}
    <Box marginTop={1} gap={wide ? 3 : 1}>
      {([['compose', '1 НОВЫЙ'], ['call', '2 ЭФИР'], ['history', '3 ИСТОРИЯ'], ['doctor', '4 ПРОВЕРКА']] as const).map(([name, label]) => <Box key={name} ref={target(`tab-${name}`, () => navigate(name))} flexShrink={0} aria-role="tab" aria-state={{selected: view === name}}><Text color={view === name ? teal : 'gray'} bold={view === name}>{view === name ? '▸ ' : ''}{label}</Text></Box>)}
    </Box>
    </Box>
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1} flexGrow={scrollingView?1:0} flexShrink={scrollingView?1:0} minHeight={scrollingView?3:undefined}>
      <Box flexShrink={0}><Text><Text color={snapshot.gatewayStatus === 'ready' ? teal : amber}>● </Text>ШЛЮЗ · {{disabled: 'отключён', connecting: 'подключение', ready: 'готов / ждём входящий', error: 'ошибка'}[snapshot.gatewayStatus]}{active && <Text color={teal}>   ● {statusNames[snapshot.current!.status]}</Text>}</Text></Box>
      {view === 'compose' && <Box flexDirection={wide ? 'row' : 'column'} marginTop={1} gap={wide ? 4 : 1}>
        <Box flexDirection="column" width={wide ? '58%' : '100%'}>
          <Text color={amber} bold>ИСХОДЯЩИЙ ЗВОНОК</Text>
          <Text dimColor>Номер · международный формат</Text>
          <Box ref={target('number', () => focus('number'))} aria-role="textbox"><Text color={field === 'number' && !commands ? teal : 'gray'}>› </Text>{input('number', number, setNumber, '+79991234567')}</Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Задача и поведение агента</Text>
            <Box ref={target('task', () => focus('task'))} aria-role="textbox"><Text color={field === 'task' && !commands ? teal : 'gray'}>› </Text>{input('task', task, setTask, 'Что узнать или сделать во время звонка?')}</Box>
          </Box>
          <Box marginTop={1}><Button elementRef={target('start', () => {focus('start'); start();})} focused={!commands && field === 'start'} disabled={!canStart}>ПОЗВОНИТЬ</Button></Box>
          <Text dimColor>Tab → кнопка · Enter → звонок</Text>
        </Box>
        {wide && <Box flexDirection="column" flexGrow={1} width="38%" gap={1}>
          <Text color={teal} bold>ЛИНИЯ ОТКРЫТА</Text>
          <Text>Задайте цель. Агент проведёт разговор, а реплики появятся в эфире.</Text>
          <Text dimColor>Входящие принимаются шлюзом автоматически, когда LIVE готов.</Text>
          <Text color={amber}>Esc → m · переключить DEMO / LIVE</Text>
        </Box>}
      </Box>}
      {view === 'call' && <Box flexDirection="column" marginTop={1} gap={1} flexGrow={1} minHeight={0}>
        {details}
        {active && <Box flexDirection="column" flexShrink={0}>
          <Text color={amber}>УКАЗАНИЕ · инструкция для агента</Text>
          <Box ref={target('instruction', () => focus('instruction'))} aria-role="textbox" height={1} overflow="hidden"><Text color={teal}>› </Text>{input('instruction', instruction, setInstruction, 'Уточни срок, попроси соединить с менеджером…')}</Box>
          <Box gap={2}>
            <Button elementRef={target('send', () => {focus('send'); steer();})} focused={!commands && field === 'send'} disabled={!instruction.trim() || Boolean(busy) || cancelling}>ПЕРЕДАТЬ</Button>
            <Button elementRef={target('hangup', () => {focus('hangup'); void hangup();})} focused={!commands && field === 'hangup'} disabled={cancelling}>ЗАВЕРШИТЬ ЗВОНОК</Button>
          </Box>
        </Box>}
      </Box>}
      {view === 'history' && <Box marginTop={1} flexDirection={wide ? 'row' : 'column'} gap={wide ? 3 : 1} flexGrow={1} minHeight={0}>
        <Box flexDirection="column" width={wide ? '32%' : '100%'} flexShrink={0}>
          <Text color={amber} bold>ИСТОРИЯ · {snapshot.history.length}</Text>
          {snapshot.history.slice(Math.max(0, selection - 2), Math.max(0, selection - 2) + (wide ? 7 : 3)).map(call => <Box key={call.id} ref={target(`history-${call.id}`, () => {setSelection(snapshot.history.indexOf(call)); setOffset(null);})} aria-role="option" aria-state={{selected: selected?.id === call.id}}><Text color={selected?.id === call.id ? teal : 'gray'} wrap="truncate-end">{selected?.id === call.id ? '›' : ' '} {time(call.startedAt)} {clean(call.number)}</Text></Box>)}
          <Text dimColor>Esc → ↑ / ↓ выбрать</Text>
        </Box>
        <Box flexDirection="column" width={wide ? '65%' : '100%'} flexGrow={1} minHeight={0}>{details}</Box>
      </Box>}
      {view === 'doctor' && <Box flexDirection="column" marginTop={1} gap={1}>
        <Text color={amber} bold>ДИАГНОСТИКА СОЕДИНЕНИЙ</Text>
        {!checks.length && <Text dimColor>{busy || 'Esc → d · проверить конфигурацию и доступность'}</Text>}
        {checks.map((check, index) => <Box key={index} flexDirection="column">
          <Text color={check.ok ? teal : amber}>{check.ok ? '✓' : '!'} {clean(check.name)}</Text>
          <Text wrap="wrap">  {clean(check.detail)}</Text>
        </Box>)}
      </Box>}
    </Box>
    <Box flexDirection="column" flexShrink={0}>
    {snapshot.configIssues.length > 0 && <Text color={amber} wrap="truncate-end">Настройка: {snapshot.configIssues.map(clean).join(' · ')}</Text>}
    <Text color={error ? 'red' : busy || cancelling ? amber : teal} wrap="truncate-end">{error ? `! ${clean(error)}` : cancelling ? 'Завершаем…' : busy || clean(snapshot.notice)}</Text>
    <Text dimColor>{commands ? '1–4 вкладки · b копировать номер · m режим' : 'Мышь: вкладки и кнопки · Ctrl+←/→ вкладки · Esc, затем 1–4'}</Text>
    <Text dimColor>{scrollingView?'Колесо / PgUp PgDn · Ctrl+Home начало · Ctrl+End конец':commands?'x завершить · s итог · t транскрипт · a запись · q выход':'Esc → q выход · Ctrl+C закрыть соединения и выйти'}</Text>
    {!isRawModeSupported && <Text color={amber}>Нет интерактивного ввода. Запустите npm start в обычном терминале.</Text>}
    </Box>
  </Box>;
}
