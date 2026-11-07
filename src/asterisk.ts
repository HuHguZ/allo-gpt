import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import WebSocket, {type RawData} from 'ws';
import type {GatewayConfig, PhoneLeg} from './types.js';

type Channel = {id: string; caller?: {number?: string}; channelvars?: Record<string, string>};
type AriEvent = {type: string; args?: string[]; channel?: Channel};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {resolve = ok; reject = fail;});
  void promise.catch(() => {});
  return {promise, resolve, reject};
}

async function waitFor(promise: Promise<void>, signal: AbortSignal, timeout: number): Promise<void> {
  if (signal.aborted) throw new Error('Call cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => reject(new Error('Call cancelled'));
      timer = setTimeout(() => reject(new Error('Asterisk call/media timed out')), timeout);
      signal.addEventListener('abort', cancel, {once: true});
      promise.then(resolve, reject);
    });
  } finally {clearTimeout(timer); signal.removeEventListener('abort', cancel);}
}

export class AsteriskGateway extends EventEmitter {
  private readonly base: URL;
  private readonly authorization: string;
  private readonly legs = new Map<string, AsteriskLeg>();
  private events?: WebSocket;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private ready = false;

  constructor(readonly config: GatewayConfig) {
    super();
    this.base = new URL(config.ariUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || !['', '/', '/ari', '/ari/'].includes(this.base.pathname)) throw new Error('ARI URL must be an HTTP origin, without credentials or query parameters');
    if (!config.ariUsername || /[:\r\n\0]/.test(config.ariUsername) || !config.ariPassword || /[\r\n\0]/.test(config.ariPassword)) throw new Error('Invalid ARI credentials');
    if (!/^[A-Za-z0-9_-]+$/.test(config.app) || !/^[A-Za-z0-9_-]+$/.test(config.trunk)) throw new Error('Invalid Asterisk application or trunk');
    if (!/^\+7\d{10}$/.test(config.callerNumber)) throw new Error('Caller number must be your connected +7 number');
    this.base.pathname = '/';
    this.authorization = `Basic ${Buffer.from(`${config.ariUsername}:${config.ariPassword}`).toString('base64')}`;
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Asterisk gateway is closed'));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.emit('status', 'connecting');
    const url = this.url('/ari/events', {app: this.config.app});
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, {headers: {Authorization: this.authorization}, handshakeTimeout: 10000, maxPayload: 1024 * 1024});
    this.events = socket;
    this.connecting = new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.once('open', () => {
        if (this.closed) {socket.terminate(); reject(new Error('Asterisk gateway is closed')); return;}
        opened = true; this.ready = true; this.emit('status', 'ready'); resolve();
      });
      socket.on('message', data => {
        try {this.onEvent(JSON.parse(data.toString()) as AriEvent);}
        catch {this.fail(new Error('Invalid ARI event'));}
      });
      socket.on('error', () => {const error = new Error('Asterisk event WebSocket failed'); reject(error); if (!this.closed) this.fail(error);});
      socket.once('close', () => {
        this.ready = false;
        if (!opened) reject(new Error('Asterisk event connection closed'));
        if (!this.closed) this.fail(new Error('Asterisk event connection lost'));
      });
    });
    return this.connecting;
  }

  async dial(number: string, signal?: AbortSignal): Promise<PhoneLeg> {
    if (!/^\+7\d{10}$/.test(number)) throw new Error('Phone number must be +7 and ten digits');
    if (!this.ready || this.closed) throw new Error('Asterisk gateway is not connected');
    if (signal?.aborted) throw new Error('Call cancelled');
    const leg = new AsteriskLeg(this, randomUUID(), false);
    this.legs.set(leg.id, leg);
    const cancel = () => {void leg.close().catch(error => this.report(error));};
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      await leg.originate(number);
      return leg;
    } catch (error) {
      await leg.close();
      throw error;
    } finally {signal?.removeEventListener('abort', cancel);}
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.ready = false;
    this.events?.terminate();
    this.closing = Promise.allSettled([...this.legs.values()].map(leg => leg.close())).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    return this.closing;
  }

  private onEvent(event: AriEvent): void {
    if (this.closed || !event.channel?.id) return;
    const id = event.channel.id;
    const leg = this.legs.get(id) ?? [...this.legs.values()].find(item => item.mediaId === id);
    if (event.type === 'StasisStart') {
      if (leg) {leg.stasis(id); return;}
      if (event.args?.[0] !== 'incoming') return;
      const incoming = new AsteriskLeg(this, id, true);
      this.legs.set(id, incoming);
      incoming.stasis(id);
      if (this.listenerCount('incoming')) this.emit('incoming', incoming, event.channel.caller?.number ?? 'unknown');
      else void incoming.close().catch(error => this.report(error));
    } else if (['ChannelTalkingStarted','ChannelTalkingFinished'].includes(event.type)&&leg) {
      leg.talking(id,event.type==='ChannelTalkingStarted');
    } else if (['StasisEnd', 'ChannelDestroyed', 'ChannelHangupRequest'].includes(event.type) && leg) {
      void leg.close().catch(error => this.report(error));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.emit('status', 'error'); this.report(error);
    void this.close().catch(error => this.report(error));
  }

  report(error: unknown): void {
    if (this.listenerCount('error')) this.emit('error', error instanceof Error ? error : new Error('Asterisk operation failed'));
  }

  ended(leg: AsteriskLeg): void {
    this.legs.delete(leg.id);
    this.emit('hangup', leg.id);
  }

  mediaSocket(connectionId: string): WebSocket {
    if (!/^[A-Za-z0-9_-]+$/.test(connectionId)) throw new Error('Invalid media connection ID');
    const url = this.url(`/media/${connectionId}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(url, 'media', {headers: {Authorization: this.authorization}, handshakeTimeout: 10000, maxPayload: 65500});
  }

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, this.base);
    url.search = new URLSearchParams(query).toString();
    return url;
  }

  async request<T = unknown>(method: string, path: string, query: Record<string, string> = {}, deleting = false): Promise<T> {
    try {
      const response = await fetch(this.url(`/ari${path}`, query), {method, headers: {Authorization: this.authorization}, signal: AbortSignal.timeout(10000), redirect: 'error'});
      if (deleting && response.status === 404) return undefined as T;
      if (!response.ok) throw new Error(`ARI ${method} failed (HTTP ${response.status})`);
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (error instanceof Error && /^ARI /.test(error.message)) throw error;
      throw new Error(`ARI ${method} request failed`);
    }
  }
}

class AsteriskLeg implements PhoneLeg {
  readonly mediaId = randomUUID();
  private readonly bridgeId = randomUUID();
  private readonly abort = new AbortController();
  private readonly phoneReady = deferred();
  private readonly mediaReady = deferred();
  private readonly pending = new Set<Promise<unknown>>();
  private socket?: WebSocket;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private mediaCreated = false;
  private bridgeCreated = false;
  private recordingStarted = false;
  private active = false;
  private paused = false;
  private sending = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private callerTalking = false;
  private agentTalking = false;

  constructor(private readonly gateway: AsteriskGateway, readonly id: string, private readonly incoming: boolean) {}

  get recordingPath():string|undefined {return this.recordingStarted?resolve('recordings',`${this.bridgeId}.wav`):undefined;}

  stasis(id: string): void {(id === this.id ? this.phoneReady : this.mediaReady).resolve();}

  talking(id:string,active:boolean):void {
    if(this.closed)return;
    if(id===this.mediaId){this.agentTalking=active;this.gateway.emit('agent-speaking',this.id,active);return;}
    this.callerTalking=active;
    if(!active)return;
    this.queue=[];this.queuedBytes=0;this.paused=false;
    if(this.socket?.readyState===WebSocket.OPEN){this.socket.send('FLUSH_MEDIA');this.socket.send('START_MEDIA_BUFFERING');}
    if(this.agentTalking)this.gateway.emit('interrupted',this.id);
  }

  async originate(number: string): Promise<void> {
    await this.api('POST', '/channels', {endpoint: `Local/${number}@gpt-outbound/n`, channelId: this.id, app: this.gateway.config.app, appArgs: 'outbound', callerId: this.gateway.config.callerNumber, timeout: '60'});
    await waitFor(this.phoneReady.promise, this.abort.signal, 65000);
    this.check();
  }

  startMedia(onAudio: (audio: Buffer) => void): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.openMedia(onAudio).catch(async error => {await this.close(); throw error;});
    return this.starting;
  }

  private async openMedia(onAudio: (audio: Buffer) => void): Promise<void> {
    this.check(); this.mediaCreated = true;
    const channel = await this.api<Channel>('POST', '/channels/externalMedia', {channelId: this.mediaId, app: this.gateway.config.app, data: 'media', transport: 'websocket', encapsulation: 'none', external_host: 'INCOMING', connection_type: 'server', format: 'slin24', direction: 'both'});
    this.check();
    const connectionId = channel.channelvars?.MEDIA_WEBSOCKET_CONNECTION_ID ?? (await this.api<{value: string}>('GET', `/channels/${this.mediaId}/variable`, {variable: 'MEDIA_WEBSOCKET_CONNECTION_ID'})).value;
    this.check();
    if (!connectionId) throw new Error('ARI media connection ID missing; chan_websocket is required');
    const socket = this.gateway.mediaSocket(connectionId); this.socket = socket;
    const connected = deferred();
    socket.on('open', connected.resolve);
    socket.on('message', (data: RawData, binary: boolean) => {
      if (this.closed) return;
      if (binary) {
        try {onAudio(Buffer.from(data as Buffer));}
        catch {this.mediaFailure(new Error('Phone audio consumer failed'));}
        return;
      }
      const text = data.toString();
      let event = text.split(/\s/, 1)[0];
      if (text.startsWith('{')) {
        try {event = (JSON.parse(text) as {event?: string}).event;}
        catch {this.mediaFailure(new Error('Invalid media control event')); return;}
      }
      if (event === 'MEDIA_XOFF') this.paused = true;
      if (event === 'MEDIA_XON') {this.paused = false; this.flush();}
    });
    socket.on('error', () => {const error = new Error('Asterisk media WebSocket failed'); connected.reject(error); this.mediaFailure(error);});
    socket.on('close', () => {const error = new Error('Asterisk media connection closed'); connected.reject(error); this.mediaFailure(error);});
    await waitFor(connected.promise, this.abort.signal, 10000);
    await waitFor(this.mediaReady.promise, this.abort.signal, 10000);
    this.check(); this.bridgeCreated = true;
    await this.api('POST', `/bridges/${this.bridgeId}`, {type: 'mixing,proxy_media'});
    this.recordingStarted=true;
    await this.api('POST', `/bridges/${this.bridgeId}/record`, {name:this.bridgeId,format:'wav',ifExists:'fail',beep:'false',terminateOn:'none'});
    await this.api('POST', `/bridges/${this.bridgeId}/addChannel`, {channel: this.id});
    await this.api('POST', `/bridges/${this.bridgeId}/addChannel`, {channel: this.mediaId});
    const detection=`${this.gateway.config.talkingSilenceMs??250},${this.gateway.config.talkingThreshold??256}`;
    for(const id of [this.id,this.mediaId])await this.api('POST',`/channels/${encodeURIComponent(id)}/variable`,{variable:'TALK_DETECT(set)',value:detection});
    if (this.incoming) await this.api('POST', `/channels/${encodeURIComponent(this.id)}/answer`);
    this.check();
    // Preserve partial PCM frames between Live chunks; Asterisk plays full frames immediately.
    socket.send('START_MEDIA_BUFFERING'); this.active = true;
  }

  sendAudio(audio: Buffer): void {
    if (!this.active || this.closed || this.callerTalking) return;
    if (audio.length % 2) {this.mediaFailure(new Error('Phone PCM audio must contain complete 16-bit samples')); return;}
    // shortcut: five seconds of local audio, end the call instead of replaying a growing backlog.
    if (this.queuedBytes + audio.length + (this.socket?.bufferedAmount ?? 0) > 240000) {this.mediaFailure(new Error('Phone audio output queue exceeded five seconds')); return;}
    for (let offset = 0; offset < audio.length; offset += 64000) this.queue.push(Buffer.from(audio.subarray(offset, offset + 64000)));
    this.queuedBytes += audio.length;
    this.flush();
  }

  private flush(): void {
    if (this.closed || this.paused || this.sending || !this.queue.length || this.socket?.readyState !== WebSocket.OPEN) return;
    const chunk = this.queue.shift()!; this.queuedBytes -= chunk.length; this.sending = true;
    this.socket.send(chunk, {binary: true}, error => {
      this.sending = false;
      if (error) this.mediaFailure(new Error('Phone audio send failed'));
      else setImmediate(() => this.flush());
    });
  }

  private mediaFailure(error: Error): void {
    if (this.closed) return;
    this.gateway.report(error);
    void this.close().catch(error => this.gateway.report(error));
  }

  private check(): void {if (this.closed) throw new Error('Call closed or cancelled');}

  private async api<T = unknown>(method: string, path: string, query: Record<string, string> = {}): Promise<T> {
    this.check();
    const request = this.gateway.request<T>(method, path, query); this.pending.add(request);
    try {return await request;} finally {this.pending.delete(request);}
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.active = false; this.abort.abort();
    this.socket?.terminate(); this.queue = []; this.queuedBytes = 0;
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      const recordingResults=await Promise.allSettled(this.recordingStarted?[this.gateway.request('POST',`/recordings/live/${this.bridgeId}/stop`,{},true)]:[]);
      const resources = [`/channels/${encodeURIComponent(this.id)}`];
      if (this.mediaCreated) resources.push(`/channels/${this.mediaId}`);
      if (this.bridgeCreated) resources.push(`/bridges/${this.bridgeId}`);
      const results = await Promise.allSettled(resources.map(path => this.gateway.request('DELETE', path, {}, true)));
      this.gateway.ended(this);
      const failed = [...recordingResults,...results].find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.closing;
  }
}
