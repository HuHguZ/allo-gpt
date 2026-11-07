import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeText} from './config.js';
import type {CallRecord, TranscriptEntry} from './types.js';

export function addTranscript(entries: TranscriptEntry[], fragment: TranscriptEntry): void {
  if (!['human','agent'].includes(fragment.role) || !Number.isFinite(fragment.startMs) || !Number.isFinite(fragment.endMs) || fragment.startMs < 0 || fragment.endMs < fragment.startMs) throw new Error('Некорректное время транскрипта.');
  const clean = {...fragment, text: safeText(fragment.text)};
  // shortcut: captions group same-speaker fragments within 600 ms; raw fragments stay in call.json.
  const previous = entries.findLast(e=>e.role === clean.role && clean.startMs >= e.startMs && clean.startMs <= e.endMs + 600);
  if (previous) { previous.text += clean.text; previous.endMs = Math.max(previous.endMs, clean.endMs); }
  else entries.push(clean);
  entries.sort((a,b)=>a.startMs-b.startMs);
}

export function transcriptText(record: CallRecord): string {
  const lines = record.entries.map(e=>{
    const seconds = Math.floor(e.startMs/1000);
    const time = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    return `${time} ${e.role==='human'?'Собеседник':'Агент'}: ${safeText(e.text)}`;
  });
  return [`Звонок ${record.id}`, `${record.direction==='demo'?'ДЕМО · реального звонка не было':'Телефонный звонок'} · ${record.number}`, `Задача: ${safeText(record.task)}`, `Статус: ${record.status}`, record.closeConfirmed ? 'Финализация подтверждена.' : 'Финализация OpenAI не подтверждена; итоговая стоимость неизвестна.', '', ...lines, ...(record.error ? ['',`Ошибка: ${safeText(record.error)}`] : []), ...(record.summary ? ['', 'Пересказ:',safeText(record.summary)] : [])].join('\n')+'\n';
}

export class CallStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly warnings: string[] = [];
  constructor(readonly root: string) {}
  directory(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Некорректный ID звонка.');
    return join(this.root,id);
  }
  async load(): Promise<CallRecord[]> {
    await mkdir(this.root,{recursive:true});
    const history: CallRecord[]=[];
    for (const entry of await readdir(this.root,{withFileTypes:true})) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
      try {
        const record: CallRecord=JSON.parse(await readFile(join(this.directory(entry.name),'call.json'),'utf8'));
        if (record.id!==entry.name || !Array.isArray(record.entries) || typeof record.startedAt!=='string' || typeof record.task!=='string' || typeof record.number!=='string') throw new Error('Некорректный формат');
        if (!['completed','failed'].includes(record.status)) { record.status='failed'; record.error='Предыдущий запуск прерван; завершение звонка не подтверждено.'; record.closeConfirmed=false; }
        record.savedPath=this.directory(record.id);
        history.push(record);
      } catch { this.warnings.push(`Не удалось прочитать ${entry.name}/call.json; файл сохранён без изменений.`); }
    }
    return history.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  }
  save(record: CallRecord): Promise<string> {
    const snapshot=structuredClone(record);
    const directory=this.directory(record.id);
    const operation=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(directory,{recursive:true});
      const text=transcriptText(snapshot);
      for (const [name,contents] of [['call.json',JSON.stringify(snapshot,null,2)+'\n'],['transcript.txt',text],['transcript.md',`# Транскрипт\n\n\`\`\`text\n${text.replace(/`/g,'ʼ')}\`\`\`\n`]]) {
        const temp=join(directory,`${name}.${randomUUID()}.tmp`);
        await writeFile(temp,contents!,{encoding:'utf8',mode:0o600});
        await rename(temp,join(directory,name!));
      }
      return directory;
    });
    this.queue=operation;
    return operation;
  }
  async flush(): Promise<void> { await this.queue; }
}
