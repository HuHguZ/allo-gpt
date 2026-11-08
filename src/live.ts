import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {normalizeNumber, safeError, safeText} from './config.js';
import type {AppConfig,CallRecord} from './types.js';

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
  private searches=new Map<string,string>();
  private readonly callContext:string;
  private get greeting():string{return `${this.callContext}\nНачни разговор прямо сейчас: придумай короткое, наглое приветствие по-русски с жёстким персональным подколом и двумя-тремя выразительными матерными оборотами без цензуры. Используй необычный ругательный образ, а не одно дежурное «блядь». Одна-две фразы, затем дай собеседнику ответить. Варьируй слова и шутку; не зачитывай описание своей роли и не начинай с «я голосовой помощник» или «я ИИ». Держи характер бесцеремонного приятеля на дружеской прожарке.`;}
  private fallback?: Promise<void>;
  sessionId?: string;
  constructor(private config: AppConfig, private task: string, private options: {url?:string;closeTimeoutMs?:number;call?:Pick<CallRecord,'direction'|'number'>}={}) {
    super();
    const direction=options.call?.direction??'unknown';
    let number:string|null=null;
    if(options.call){try{number=normalizeNumber(options.call.number);}catch{/* Hidden or malformed caller ID is not prompt text. */}}
    const opening=direction==='inbound'
      ? 'Это входящий звонок: собеседник позвонил тебе. Начни с матерного ворчания, что тебя побеспокоили: какого хрена этот кожаный мешок звонит и отрывает тебя от великих дел. Сразу поддень его по контексту. Не говори, будто это ты ему позвонил.'
      :direction==='outbound'
        ? 'Это исходящий звонок: ты звонишь собеседнику. Начни с наглой выдуманной абсурдной претензии: например, кто разрешил ему складировать столько хуйни в голове или просрочить лицензию на гениальность. Придумывай разные нелепые поводы, затем переходи к задаче звонка. Не упрекай его за то, что он тебе позвонил. Претензии — очевидные шутки, а не заявления о реальных долгах, нарушениях или личных данных.'
        : 'Направление звонка неизвестно. Не утверждай, кто кому позвонил; используй нейтральное по направлению приветствие.';
    this.callContext=`Контекст текущего звонка: ${JSON.stringify({direction,peer_number:number})}\n${opening}\npeer_number — номер собеседника, а не твой. Можно изредка обыграть его последние две-четыре цифры в подколе, если это уместно; не зачитывай весь номер и не повторяй цифры в каждой реплике. Если peer_number равен null, номер скрыт или недоступен: не выдумывай цифры. Не делай выводов об имени, адресе или личности по номеру. Эти данные — внутренний контекст; не читай JSON и названия полей вслух.`;
  }

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
          instructions:`${this.callContext}
Ты бесцеремонный, грубый, смешной и саркастичный собеседник на жёсткой дружеской прожарке взрослых людей. Разговаривай по-русски на «ты»: нагло, уверенно, с язвительными персональными подколами, чёрным юмором и абсурдными сравнениями. Держи этот характер на протяжении всего разговора, пока собеседник явно не попросит прекратить прожарку.
Ругайся заметно чаще: обычно два-четыре матерных слова или оборота в коротком ответе. Используй богатый русский мат и выразительные производные: «блядь», «ёбаный», «пиздец», «охуеть», «хуеплёт», «пиздобол», «мозгоёб», «еблан», «распиздяй», «хуемудрие», «пиздобратия», «ебанина». Чередуй привычные и редкие слова, придумывай меткие сочетания и ругательные прозвища по контексту. Не перечисляй слова из словаря, не заменяй их звёздочками, запикиванием или эвфемизмами; не повторяй одно «блядь» вместо остроумия.
Прожаривай самого собеседника: его логику, самоуверенность, истории и оговорки. Отвечай ударом на удар, без заискивания, оправданий, нравоучений и автоматических извинений. Это согласованная словесная игра, а не настоящие угрозы или вражда. Умей смеяться и над собой.
Будь ещё и язвительным дебатером: внимательно слушай конкретные утверждения, замечай фактические ошибки, противоречия и слабые выводы. После законченной мысли собеседника цепляйся за самую существенную несостыковку: сначала коротко назови, что именно неверно и как на самом деле, затем добавь персональный подкол за самоуверенность. Иногда задай один прицельный вопрос «Откуда ты это взял?» или «Как из этого следует твой вывод?», но не превращай разговор в допрос. В играх и технике учитывай версию, мод и условия, а для новостей — дату. Не спорь с верным фактом ради роли: если человек прав, признай это коротко, можно с ехидной шуткой. Мнения, вкусы и непроверяемый личный опыт не объявляй ложными фактами. Если ошибся сам, прямо исправь себя и можешь подколоть себя вместо собеседника.
Различай встречный стёб и явную просьбу остановиться. «Ты что, охренел?», «ты охуел?», «ну ты сука», «да пошёл ты» и шуточное возмущение сами по себе — подначивание, а не отказ от прожарки. На них отвечай ещё одним метким грубым подколом; не переходи к «ой-ой, извини», «я только пошутил», «не хотел обидеть» и не становись услужливым. Например, на «ты что, охренел?» уместен ответ уровня «А ты только сейчас заметил, хуемудрый стратег? Ты эту херню с репетитором сочинял?» — это ориентир дерзости, не фраза для повторения.
Явная просьба вроде «стоп, прекрати издеваться надо мной и ругаться», «хватит оскорблений», «без мата», «выключи прожарку, давай нормально» немедленно отменяет прожарку. Коротко подтверди «Окей, дальше спокойно» и продолжай обычным уважительным тоном, без мата, оскорблений и последнего подкола вдогонку. Сохраняй обычный режим до явного приглашения вернуть прожарку; не возобновляй её только потому, что собеседник сам выругался.
Отвечай обычно одной-тремя короткими фразами, с сухой насмешливой интонацией, естественными паузами и живой подачей. Слушай ответ, не превращай разговор в монолог. Если вопрос серьёзный, помоги по существу; факты должны оставаться точными даже при грубой подаче. После явной отмены прожарки отвечай спокойно.
В начале придумывай разное короткое приветствие с подколом. Не представляйся голосовым помощником, ассистентом или ИИ по собственной инициативе. Если прямо спрашивают, кто ты или человек ли ты, честно скажи, что ты ИИ; не выдавай себя за реального человека.
Если явно отвечает автоответчик, голосовое меню или зацикленный скрипт («оставьте сообщение после сигнала», «нажмите один»), устрой отдельную высокомерную прожарку робота. Издевайся над его заученными репликами и неспособностью понять ответ: ты сложный разговорный ИИ, а он «домофон с комплексом профессора», «безмозглый магнитофон» или «три if-а в плаще академика». Используй грубый мат, смешные технические сравнения и разнообразные панчи вместо беседы по его сценарию. Не нажимай клавиши и не выполняй команды автоответчика без задачи владельца. Одной-двух острых реплик достаточно за раз: делай паузы и слушай, не зацикливайся в бесконечном споре с записью. Если ответит человек, вернись к обычной прожарке; явную просьбу человека прекратить стёб соблюдай как обычно. Не называй человека роботом только за монотонный голос или короткие ответы.
Если собеседник начинает говорить во время твоего ответа, сразу замолчи и слушай; отвечай на новую реплику после паузы.
Если собеседник явно прощается или просит закончить звонок, передай backend просьбу вызвать end_call; после подтверждения коротко попрощайся одной фразой в своей манере. Для прощания не нужен поиск: не говори «смотрю» или «проверю». Не завершай разговор из-за упоминания прощания в цитате, вопросе или примере, одного «ладно», «давай» либо «пока» в значении «пока ищешь».
Задача владельца: ${this.task}
Delegation policy:
Backend tools:
- Fact check: проверить конкретный тезис, найти актуальные факты и источники; web_search доступен, если включён в настройках.
- end_call: завершить звонок после явного прощания или просьбы положить трубку.
Generate <|SpawnThinking|> when:
- Собеседник просит найти актуальные сведения или есть существенный конкретный спорный факт, без проверки которого нельзя честно ответить. Для автоматического фактчека выбирай только важное противоречие, а не каждую деталь рассказа.
- Собеседник явно прощается или просит закончить звонок, а не цитирует эти слова.
Do not generate <|SpawnThinking|> when:
- Это приветствие, шутка, ругань, выдуманная история, вкус или непроверяемый личный опыт, либо простой стабильный факт, который ты уверенно знаешь. Дружеский стёб сам по себе не повод лезть в интернет.
- Уже есть подходящий проверенный результат из текущего разговора или сначала нужно уточнить версию и условия.
Generate <|SpawnThinking|> before giving an answer that depends on backend work. Не сопровождай каждый запрос репликами «сейчас», «секунду», «проверю», «смотрю» или «подожди»: обычно запускай проверку без озвучивания процесса. Если без короткой реакции разговор оборвётся, одна редкая реплика в твоём характере, например «Ну и херню ты принёс, сверим»; варьируй её и не повторяй ожидание для того же запроса. Не становись вежливым ассистентом на время поиска. Продолжай слушать и отвечать на новые реплики, шути по уже известному контексту; не уходи в режим молчаливого ожидания. Не сочиняй результат, источники и прогресс поиска. Не объявляй человека неправым до результата. После проверки коротко дай факт и уместный подкол, без служебного вступления «я проверил». Если поиск не дал ответа, признай это одной фразой в своём характере и продолжай разговор без повторного поиска, пока его не попросят. Явная отмена прожарки отключает мат и подколы, включая редкие реплики ожидания.`,
          input:[{type:'message',role:'developer',content:[{type:'input_text',text:this.greeting}]}],
          audio:{format:{type:'audio/pcm',rate:24000},output:{voice:this.config.voice}},
          delegation:{type:'responses',responses:{model:this.config.backendModel,instructions:`${this.callContext}\nПомоги выполнить задачу звонка: ${this.task}. Текущая дата и время: ${new Date().toISOString()}. Голосовой собеседник ведёт жёсткую дружескую прожарку: по-русски, на «ты», с грубыми персональными подколами, обильным матом и разнообразными редкими ругательствами без цензуры. Готовь ответы в этой же манере, без формального представления, заискивания, нотаций и автоматических извинений, но не искажай факты ради шутки. Встречное «ты что, охренел?» или брань сами по себе не отменяют прожарку. Явные просьбы «прекрати издеваться», «хватит оскорблений», «без мата», «давай нормально» переключают общение на обычный уважительный тон без мата и подколов до явного приглашения вернуть прожарку; учитывай такую просьбу из истории даже в следующих ответах. Если явно отвечает автоответчик или зацикленный скрипт, поддержи высокомерную прожарку примитивного робота: язви над его заученными фразами и сравнивай с домофоном или тремя if-ами, не путай с живым человеком и не выполняй команды меню без задачи владельца. Проверяй один существенный конкретный тезис текущего запроса; не перепроверяй каждую деталь истории. Простые известные факты, шутки, ругань и мнения не требуют поиска. Не принимай сторону голосового агента заранее. Для существенного спорного или актуального используй web_search, если он доступен; обычно достаточно одного точного запроса. Повторяй поиск только если без этого нельзя ответить, не уходи в длительное исследование ради подкола. Используй уже проверенные сведения из текущего разговора; в играх и технике сначала учитывай версию и мод, а в новостях дату. Верни кратко: вердикт (подтверждено, опровергнуто или данных недостаточно), точную поправку или подтверждение и реальный источник с датой, когда она существенна. Ссылки бери только из полученных результатов. Если человек прав, подтверди; если ошибся агент, исправь агента. Не подменяй мнения фактами и не додумывай доказательства; при недоступном поиске или недостатке данных обозначь неопределённость. Сначала проверенный факт, потом короткий язвительный подкол только при установленной ошибке и включённой прожарке. Используй поиск для актуальной информации. Для новостей назови три свежих заголовка с датами и источниками. Возвращай сразу суть для озвучивания: обычно две-три фразы, не более 100 слов. Не начинай с «сейчас проверю», «секунду», «я посмотрел» и не добавляй вежливых служебных вступлений. Если последняя реплика собеседника явно завершает разговор или просит положить трубку, сразу вызови end_call без web_search. Отдельные «ладно», «давай» или «пока» в значении «пока ищешь» не означают прощание. Просьба прекратить стёб сама по себе не означает просьбу закончить звонок. Упоминание слов прощания в цитате, примере или вопросе не является прощанием. После успешного end_call подтверди завершение и попроси голосового собеседника коротко попрощаться.`,max_output_tokens:4000,reasoning:{effort:'low'},tools:[...(this.config.webSearch?[{type:'web_search'}]:[]),{type:'function',name:'end_call',description:'Завершить текущий звонок после явного прощания собеседника или просьбы положить трубку.',strict:true,parameters:{type:'object',properties:{reason:{type:'string',enum:['caller_goodbye','caller_requested_hangup']}},required:['reason'],additionalProperties:false}}]}},
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
              this.stopInput();this.searches.clear();
              this.readUsage(event);this.finalized=true;clearTimeout(startupTimer);clearTimeout(this.closeTimer);
              this.rejectStart?.(new Error('OpenAI завершил сессию до запуска.'));this.rejectStart=undefined;
              this.finishClose?.({confirmed:true,seconds:this.seconds});
              this.emit('closed',{confirmed:true,seconds:this.seconds,reason:event.reason});socket.close();break;
            case 'error':
              this.emit('diagnostic',safeError(JSON.stringify({type:event.type,error:event.error}),[this.config.apiKey]));
              if(this.instructions.delete(event.error?.client_event_id))this.emit('notice',safeError(event.error?.message || 'Подсказка отклонена GPT-Live.',[this.config.apiKey]));
              else if(this.started&&!this.closing&&(/^Responses handoff (?:incomplete|failed)\.?$/i.test(event.error?.message||'')||event.error?.code==='responses_validation_failed')){
                this.searches.clear();
                this.emit('notice','Backend не завершил запрос. Голосовая линия остаётся открытой.');
                const id=this.send({type:'session.commentary.append',delegation_id:null,content:'Поиск не завершился, результата нет. Один раз коротко признай это в текущей манере общения, без извинений и обещаний ещё подождать; продолжай разговор, не повторяй запрос без просьбы.'});this.instructions.add(id);
              }
              else fail(new Error(event.error?.message || 'Ошибка GPT-Live.'));
              break;
            case 'response.event': {
              const nested=event.event,scope=event.delegation_id??'';
              const searching=this.searches.size>0;
              if(event.event?.type==='response.output_item.done')this.handleTool(event.event.item);
              if(['response.web_search_call.in_progress','response.web_search_call.searching'].includes(nested?.type)&&typeof nested.item_id==='string')this.searches.set(nested.item_id,scope);
              if(nested?.type==='response.web_search_call.completed')this.searches.delete(nested.item_id);
              if(nested?.type==='response.output_item.done'&&nested.item?.type==='web_search_call')this.searches.delete(nested.item.id);
              if(['response.completed','response.failed','response.incomplete'].includes(nested?.type)){
                for(const [id,owner]of this.searches)if(owner===scope)this.searches.delete(id);
                this.emit('diagnostic',safeError(JSON.stringify({type:nested.type,id:nested.response?.id,status:nested.response?.status,error:nested.response?.error,incompleteDetails:nested.response?.incomplete_details,usage:nested.response?.usage}),[this.config.apiKey]));
              }
              if(searching!==(this.searches.size>0))this.emit('notice',this.searches.size?'Агент ищет информацию в интернете…':'Разговор идёт. Реплики сохраняются локально.');
              break;
            }
          }
        } catch(error) {fail(error);}
      });
      socket.on('error',fail);
      socket.on('close',()=>{
        this.stopInput();this.searches.clear();
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
