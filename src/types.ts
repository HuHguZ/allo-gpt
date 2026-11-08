export type Mode = 'demo' | 'live';
export type CallStatus = 'dialing' | 'ringing' | 'active' | 'ending' | 'completed' | 'failed';
export interface TranscriptEntry {
  role: 'human' | 'agent';
  text: string;
  startMs: number;
  endMs: number;
}
export interface CallRecord {
  id: string;
  direction: 'outbound' | 'inbound' | 'demo';
  number: string;
  task: string;
  startedAt: string;
  endedAt?: string;
  status: CallStatus;
  entries: TranscriptEntry[];
  fragments?: TranscriptEntry[];
  sessionId?: string;
  voiceSeconds?: number;
  closeConfirmed: boolean;
  error?: string;
  summary?: string;
  savedPath?: string;
  recordingPath?: string;
  diagnostics?:string[];
  hangupReason?:string;
}
export interface Check {name: string; ok: boolean; detail: string}
export interface RecordingPlayback {id:string;positionSeconds:number;durationSeconds:number;paused:boolean}
export interface Snapshot {
  mode: Mode;
  gatewayStatus: 'disabled' | 'connecting' | 'ready' | 'error';
  configIssues: string[];
  current?: CallRecord;
  history: CallRecord[];
  notice: string;
  playback?:RecordingPlayback;
  ownNumber?:string;
  ownNumberSource?:'config'|'api';
  ownNumberError?:string;
}
export interface ConsoleController {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  setMode(mode: Mode): Promise<void>;
  startCall(number: string, task?: string): Promise<void>;
  hangup(): Promise<void>;
  sendInstruction(text: string): Promise<void>;
  summarize(id: string): Promise<void>;
  sendTranscript(id: string): Promise<void>;
  playRecording(id: string,positionSeconds?:number): Promise<void>;
  pauseRecording():Promise<void>;
  seekRecording(positionSeconds:number):Promise<void>;
  stopRecording():Promise<void>;
  deleteHistory(id?:string):Promise<void>;
  copyOwnNumber():Promise<void>;
  refreshOwnNumber():Promise<void>;
  doctor(): Promise<Check[]>;
  close(): Promise<void>;
}
export interface PhoneLeg {
  id: string;
  readonly recordingPath?:string;
  startMedia(onAudio: (audio: Buffer) => void): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): Promise<void>;
}
export interface GatewayConfig {
  ariUrl: string;
  ariUsername: string;
  ariPassword: string;
  app: string;
  trunk: string;
  callerNumber: string;
  talkingThreshold?:number;
  talkingSilenceMs?:number;
}
export interface AppConfig {
  mode: Mode;
  apiKey: string;
  liveModel: string;
  backendModel: string;
  voice: string;
  webSearch: boolean;
  plusofonToken:string;
  gateway: GatewayConfig;
  maxCallSeconds: number;
  allowedNumbers: string[];
  callsDir: string;
  telegramToken: string;
  telegramChatId: string;
}
