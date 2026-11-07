import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {safeError, safeText} from './config.js';
import type {AppConfig} from './types.js';

export interface FinalUsage {confirmed: boolean; seconds?: number}
export class LiveSession extends EventEmitter {
  private socket?: WebSocket;
  private started=false;
  private closing=false;
  private finalized=false;
  private seen=new Set<string>();
  private closePromise?: Promise<FinalUsage>;
  private finishClose?: (value: FinalUsage)=>void;
  private rejectStart?: (error: Error)=>void;
  private seconds?: number;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private instructions=new Set<string>();
  private inputAudio=Buffer.alloc(0);
  private inputClock?:ReturnType<typeof setInterval>;
  private handledTools=new Set<string>();
  private readonly greeting='Начни разговор сейчас по-русски: коротко представься ИИ-помощником, спроси, чем помочь, затем слушай собеседника.';
  private fallback?: Promise<void>;
  sessionId?: string;
  constructor(private config: AppConfig, private task: string, private options: {url?:string;closeTimeoutMs?:number}={}) { super(); }

  connect(): Promise<void> {
    if(this.socket) return Promise.reject(new Error('Сессия уже открыта.'));
    return new Promise((resolve,reject)=>{
      this.rejectStart=reject;
      let startupTimer: ReturnType<typeof setTimeout>;
      const socket=new WebSocket(this.options.url || 'wss://api.openai.com/v1/live/sessions',{headers:{Authorization:`Bearer ${this.config.apiKey}`},handshakeTimeout:10000,maxPayload:2*1024*1024});
      this.socket=socket;
      const fail=(error:unknown)=>{
        const message=safeError(error,[this.config.apiKey]);
        clearTimeout(startupTimer); this.rejectStart?.(new Error(message)); this.rejectStart=undefined;
        this.emit('failure',message);
      };
      startupTimer=setTimeout(()=>{fail(new Error('OpenAI не подтвердил запуск за 15 секунд.'));void this.close();},15000);
      socket.on('open',()=>{
        this.send({type:'session.start',session:{
          model:this.config.liveModel,store:false,
          instructions:`Ты голосовой ИИ-помощник. Общайся по-русски, естественно и коротко. Представься ИИ-помощником в начале. Если собеседник начинает говорить во время твоего ответа, сразу замолчи и слушай; отвечай на новую реплику после паузы. Если собеседник явно прощается или просит закончить звонок, передай backend просьбу вызвать end_call; после подтверждения коротко попрощайся одной фразой. Не завершай разговор из-за упоминания прощания в цитате, вопросе или примере. Задача владельца: ${this.task}\nДля актуальных фактов и инструментов обращайся к backend. Не утверждай, что действие выполнено, пока нет результата.`,
          input:[{type:'message',role:'developer',content:[{type:'input_text',text:this.greeting}]}],
          audio:{format:{type:'audio/pcm',rate:24000},output:{voice:this.config.voice}},
          delegation:{type:'responses',responses:{model:this.config.backendModel,instructions:`Помоги выполнить задачу звонка: ${this.task}. Текущая дата и время: ${new Date().toISOString()}. Используй поиск для актуальной информации. Для новостей назови три свежих заголовка с датами и источниками. Возвращай краткий проверенный результат для озвучивания, не более 150 слов. Если последняя реплика собеседника явно завершает разговор или просит положить трубку, вызови end_call. Упоминание слов прощания в цитате, примере или вопросе не является прощанием. После успешного end_call подтверди завершение и попроси голосового помощника коротко попрощаться.`,max_output_tokens:4000,tools:[...(this.config.webSearch?[{type:'web_search'}]:[]),{type:'function',name:'end_call',description:'Завершить текущий звонок после явного прощания собеседника или просьбы положить трубку.',strict:true,parameters:{type:'object',properties:{reason:{type:'string',enum:['caller_goodbye','caller_requested_hangup']}},required:['reason'],additionalProperties:false}}]}},
        }});
      });
      socket.on('message',data=>{
        try {
          const event=JSON.parse(data.toString());
          if(event.event_id) {if(this.seen.has(event.event_id))return;this.seen.add(event.event_id);}
          switch(event.type) {
            case 'session.started':
              if(typeof event.session?.id!=='string')throw new Error('OpenAI вернул сессию без ID.');
              this.sessionId=event.session.id;this.started=true;clearTimeout(startupTimer);this.rejectStart=undefined;resolve();
              if(this.closing)this.send({type:'session.close'});
              break;
            case 'session.input_transcript.delta':
            case 'session.output_transcript.delta':
              if(typeof event.delta!=='string' || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms))throw new Error('Некорректный фрагмент транскрипта OpenAI.');
              this.emit('transcript',{role:event.type==='session.input_transcript.delta'?'human':'agent',text:safeText(event.delta),startMs:event.start_ms,endMs:event.end_ms});break;
            case 'session.output_audio.delta':
              if(!this.closing && typeof event.delta==='string')this.emit('audio',Buffer.from(event.delta,'base64'));break;
            case 'session.usage.updated': this.readUsage(event);break;
            case 'session.closed':
              this.stopInput();
              this.readUsage(event);this.finalized=true;clearTimeout(startupTimer);clearTimeout(this.closeTimer);
              this.rejectStart?.(new Error('OpenAI завершил сессию до запуска.'));this.rejectStart=undefined;
              this.finishClose?.({confirmed:true,seconds:this.seconds});
              this.emit('closed',{confirmed:true,seconds:this.seconds,reason:event.reason});socket.close();break;
            case 'error':
              this.emit('diagnostic',safeError(JSON.stringify({type:event.type,error:event.error}),[this.config.apiKey]));
              if(this.instructions.delete(event.error?.client_event_id))this.emit('notice',safeError(event.error?.message || 'Подсказка отклонена GPT-Live.',[this.config.apiKey]));
              else if(this.started&&!this.closing&&(/^Responses handoff (?:incomplete|failed)\.?$/i.test(event.error?.message||'')||event.error?.code==='responses_validation_failed')){
                this.emit('notice','Backend не завершил запрос. Голосовая линия остаётся открытой.');
                const id=this.send({type:'session.commentary.append',delegation_id:null,content:'Поиск не завершился, результата нет. Сообщи об этом и слушай; не повторяй запрос без просьбы.'});this.instructions.add(id);
              }
              else fail(new Error(event.error?.message || 'Ошибка GPT-Live.'));
              break;
            case 'response.event':
              if(event.event?.type==='response.output_item.done')this.handleTool(event.event.item);
              if(String(event.event?.type).includes('web_search_call'))this.emit('notice','Агент ищет информацию в интернете…');
              if(['response.completed','response.failed','response.incomplete'].includes(event.event?.type))this.emit('diagnostic',safeError(JSON.stringify({type:event.event.type,id:event.event.response?.id,status:event.event.response?.status,error:event.event.response?.error,incompleteDetails:event.event.response?.incomplete_details,usage:event.event.response?.usage}),[this.config.apiKey]));
              break;
          }
        } catch(error) {fail(error);}
      });
      socket.on('error',fail);
      socket.on('close',()=>{
        this.stopInput();
        clearTimeout(startupTimer);
        this.rejectStart?.(new Error('Соединение с OpenAI закрыто до session.started.'));this.rejectStart=undefined;
        if(!this.finalized){void this.unconfirmedClose();if(!this.closing)this.emit('failure','Соединение с OpenAI потеряно; финализация не подтверждена.');}
      });
    });
  }

  private readUsage(event:any): void {if(Number.isFinite(event.usage?.seconds))this.seconds=event.usage.seconds;}
  private handleTool(item:any):void {
    if(this.closing||item?.type!=='function_call'||item.name!=='end_call'||typeof item.call_id!=='string'||!item.call_id||item.call_id.length>512||this.handledTools.has(item.call_id))return;
    this.handledTools.add(item.call_id);if(this.handledTools.size>100)this.handledTools.delete(this.handledTools.values().next().value!);
    let reason:string|undefined;try{const args=JSON.parse(item.arguments);if(Object.keys(args).length===1&&['caller_goodbye','caller_requested_hangup'].includes(args.reason))reason=args.reason;}catch{}
    const accepted=!!reason&&this.listenerCount('hangup-requested')>0;
    this.send({type:'response.item.create',item:{type:'function_call_output',call_id:item.call_id,output:JSON.stringify({status:accepted?'scheduled':'rejected'})}});
    this.send({type:'response.create'});
    if(accepted){this.emit('diagnostic',`end_call scheduled: ${reason}`);this.emit('hangup-requested',reason);}
  }
  private send(event:Record<string,unknown>): string {
    if(this.socket?.readyState!==WebSocket.OPEN)throw new Error('Соединение GPT-Live не открыто.');
    if(this.socket.bufferedAmount>1024*1024)throw new Error('Соединение GPT-Live не успевает передавать звук.');
    const event_id=randomUUID();this.socket.send(JSON.stringify({...event,event_id}));return event_id;
  }
  sendAudio(audio:Buffer): void {
    if(!this.started || this.closing)return;
    if(audio.length%2)throw new Error('Phone PCM audio must contain complete 16-bit samples.');
    if(this.inputAudio.length+audio.length>240000)throw new Error('Phone input audio queue exceeded five seconds.');
    this.inputAudio=Buffer.concat([this.inputAudio,audio]);
  }
  startConversation():void {
    if(!this.started || this.closing)throw new Error('Нет активного разговора.');
    if(this.inputClock)return;
    // Live needs a continuous audio timeline even before RTP arrives or the caller speaks.
    const startedAt=performance.now();let sentFrames=0;
    this.inputClock=setInterval(()=>{
      try{
        // Timer callbacks can arrive late; consume elapsed audio time rather than one frame per callback.
        const frames=Math.min(250,Math.floor((performance.now()-startedAt)/20)-sentFrames);if(frames<=0)return;
        const frame=Buffer.alloc(frames*960);this.inputAudio.copy(frame,0,0,frame.length);this.inputAudio=this.inputAudio.subarray(Math.min(frame.length,this.inputAudio.length));
        this.send({type:'session.input_audio.append',audio:frame.toString('base64')});
        sentFrames+=frames;
      }catch(error){this.stopInput();this.emit('failure',safeError(error,[this.config.apiKey]));}
    },20);
    const id=this.send({type:'session.commentary.append',delegation_id:null,content:this.greeting});this.instructions.add(id);
  }
  private stopInput():void {
    clearInterval(this.inputClock);this.inputClock=undefined;this.inputAudio=Buffer.alloc(0);
  }
  instruct(text:string): void {
    if(!this.started || this.closing)throw new Error('Нет активного разговора.');
    if(!text.trim() || text.length>1200)throw new Error('Подсказка: от 1 до 1200 символов.');
    const id=this.send({type:'session.instructions.append',delegation_id:null,content:safeText(text)});
    this.instructions.add(id);
    if(this.instructions.size>100)this.instructions.delete(this.instructions.values().next().value!);
  }
  private async unconfirmedClose():Promise<void> {
    if(!this.fallback)this.fallback=(async()=>{
      if(!this.sessionId)return;
      const url=new URL(this.options.url || 'https://api.openai.com/v1/live/sessions');
      url.protocol=url.protocol==='ws:'?'http:':'https:';url.pathname+=`/${encodeURIComponent(this.sessionId)}/hangup`;
      try{
        const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`},signal:AbortSignal.timeout(5000)});
        await response.body?.cancel();
        if(!response.ok)this.emit('notice',`Аварийное завершение OpenAI: HTTP ${response.status}. Проверьте активные сессии и расход.`);
      }catch{this.emit('notice','Не удалось подтвердить аварийное завершение OpenAI. Проверьте активные сессии и расход.');}
    })();
    await this.fallback;this.finishClose?.({confirmed:false,seconds:this.seconds});
  }
  close(): Promise<FinalUsage> {
    if(this.closePromise)return this.closePromise;
    if(this.finalized)return Promise.resolve({confirmed:true,seconds:this.seconds});
    this.closing=true;this.stopInput();
    this.closePromise=new Promise(resolve=>{
      this.finishClose=value=>{clearTimeout(this.closeTimer);resolve(value);};
      if(!this.socket || this.socket.readyState===WebSocket.CLOSED){void this.unconfirmedClose();return;}
      this.closeTimer=setTimeout(()=>{
        this.socket?.terminate();void this.unconfirmedClose();
      },this.options.closeTimeoutMs??10000);
      if(this.started && this.socket.readyState===WebSocket.OPEN) {
        try{this.send({type:'session.close'});}catch{this.socket.terminate();}
      }
    });
    return this.closePromise;
  }
}
