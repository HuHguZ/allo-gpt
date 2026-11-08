import {mkdir, readFile, readdir, rename, writeFile, lstat, realpath, unlink, rm} from 'node:fs/promises';
import {join, resolve, dirname, basename} from 'node:path';
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
  private deleted=new Set<string>();
  readonly warnings: string[] = [];
  constructor(readonly root: string,readonly recordingsRoot=resolve('recordings')) {}
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
      if(this.deleted.has(snapshot.id))throw new Error('Звонок уже удалён.');
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
  remove(record:Pick<CallRecord,'id'|'recordingPath'>):Promise<void>{
    const id=record.id,directory=resolve(this.directory(id)),recording=record.recordingPath?resolve(record.recordingPath):undefined;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      let hasDirectory=false,hasRecording=false;
      // Validate both targets before deleting either; saved JSON is not a trusted path source.
      try{
        const info=await lstat(directory);
        if(!info.isDirectory()||info.isSymbolicLink()||dirname(await realpath(directory))!==await realpath(this.root))throw new Error('Недопустимый путь каталога звонка.');
        hasDirectory=true;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(recording){
        if(dirname(recording)!==resolve(this.recordingsRoot)||!/^[a-f0-9-]{36}\.wav$/i.test(basename(recording)))throw new Error('Недопустимый путь аудиозаписи.');
        try{
          const info=await lstat(recording);
          if(!info.isFile()||info.isSymbolicLink()||dirname(await realpath(recording))!==await realpath(this.recordingsRoot))throw new Error('Недопустимый путь аудиозаписи.');
          hasRecording=true;
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      if(hasRecording)await unlink(recording!);
      if(hasDirectory)await rm(directory,{recursive:true,force:true});
      this.deleted.add(id);
    });
    this.queue=operation.catch(()=>{});return operation;
  }
  async clearOrphans():Promise<void>{
    await this.queue.catch(()=>{});
    const missing=(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;};
    const directories=await readdir(this.root,{withFileTypes:true}).catch(missing);
    const recordings=await readdir(this.recordingsRoot,{withFileTypes:true}).catch(missing);
    const artifacts=new Map<string,string|undefined>();
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    for(const entry of directories)if(uuid.test(entry.name))artifacts.set(entry.name,undefined);
    // Failed media setup can leave a bridge UUID WAV without a call.json link.
    for(const entry of recordings)if(entry.name.toLowerCase().endsWith('.wav')&&uuid.test(entry.name.slice(0,-4)))artifacts.set(entry.name.slice(0,-4),resolve(this.recordingsRoot,entry.name));
    for(const [id,recordingPath] of artifacts)await this.remove({id,recordingPath});
  }
  async flush(): Promise<void> { await this.queue; }
}
