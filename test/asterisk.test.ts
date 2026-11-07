import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {WebSocketServer, WebSocket} from 'ws';
import {AsteriskGateway} from '../src/asterisk.js';
import type {GatewayConfig, PhoneLeg} from '../src/types.js';
import {renderAsteriskConfig} from '../scripts/setup-asterisk.js';

async function fakeAri(options: {failMedia?: boolean; failDial?: boolean; delayDial?: boolean; noConnectionId?: boolean; lateOriginate?: boolean} = {}) {
  const requests: {method: string; url: URL; authorization?: string; body: string}[] = [];
  const channels = new Set<string>();
  const bridges = new Set<string>();
  const mediaMessages: {binary: boolean; data: Buffer}[] = [];
  let events: WebSocket | undefined;
  let media: WebSocket | undefined;
  let dialId = '';
  let mediaId = '';
  const emit = (event: object) => events?.send(JSON.stringify(event));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({method: req.method!, url, authorization: req.headers.authorization, body});
    if (req.headers.authorization !== `Basic ${Buffer.from('phone:private-test-password').toString('base64')}`) {
      res.writeHead(401).end(); return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      channels.delete(id); bridges.delete(id); res.writeHead(204).end(); return;
    }
    if (url.pathname === '/ari/channels' && req.method === 'POST') {
      dialId = url.searchParams.get('channelId')!;
      if (options.lateOriginate) await new Promise(resolve => setTimeout(resolve, 40));
      channels.add(dialId);
      if (options.failDial) {res.writeHead(503).end('{}'); return;}
      res.end(JSON.stringify({id: dialId}));
      if (!options.delayDial) setTimeout(() => emit({type: 'StasisStart', args: ['outbound'], channel: {id: dialId}}), 5);
    } else if (url.pathname === '/ari/channels/externalMedia') {
      mediaId = url.searchParams.get('channelId')!;
      channels.add(mediaId);
      if (options.failMedia) {res.writeHead(500).end('{}'); return;}
      res.end(JSON.stringify({id: mediaId, channelvars: options.noConnectionId ? {} : {MEDIA_WEBSOCKET_CONNECTION_ID: 'connection-test'}}));
    } else if (url.pathname.endsWith('/variable')) {
      res.end(JSON.stringify({value: options.noConnectionId ? '' : 'connection-test'}));
    } else if (url.pathname.startsWith('/ari/bridges/') && url.pathname.endsWith('/addChannel')) {
      assert.ok(channels.has(url.searchParams.get('channel')!));
      res.writeHead(204).end();
    } else if (url.pathname.startsWith('/ari/bridges/') && url.pathname.endsWith('/record')) {
      res.end(JSON.stringify({name:url.searchParams.get('name'),format:'wav',state:'recording'}));
    } else if (url.pathname.startsWith('/ari/bridges/') && req.method === 'POST') {
      const id = url.pathname.split('/').at(-1)!; bridges.add(id); res.end(JSON.stringify({id}));
    } else res.writeHead(204).end();
  });
  const ws = new WebSocketServer({noServer: true});
  server.on('upgrade', (req, socket, head) => {
    requests.push({method: 'UPGRADE', url: new URL(req.url!, 'http://localhost'), authorization: req.headers.authorization, body: ''});
    ws.handleUpgrade(req, socket, head, client => {
      if (req.url!.startsWith('/ari/events?')) events = client;
      else {
        assert.equal(req.headers['sec-websocket-protocol'], 'media');
        media = client;
        client.on('message', (data, binary) => mediaMessages.push({binary, data: Buffer.from(data as Buffer)}));
        client.send('MEDIA_START connection_id:connection-test format:slin24 optimal_frame_size:960');
        emit({type: 'StasisStart', args: ['media'], channel: {id: mediaId}});
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as {port: number};
  const config: GatewayConfig = {ariUrl: `http://127.0.0.1:${address.port}`, ariUsername: 'phone', ariPassword: 'private-test-password', app: 'gpt-live-phone', trunk: 'plusofon', callerNumber: '+79990000000'};
  return {config, requests, channels, bridges, mediaMessages, emit, get media() {return media;}, get events() {return events;}, get dialId() {return dialId;},get mediaId(){return mediaId;},
    async close() {for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}};
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for fake ARI interaction');
}

test('outbound ARI and media use auth headers, bridge PCM, obey flow control and clean up', async t => {
  const ari = await fakeAri(); t.after(() => ari.close());
  const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close());
  await gateway.connect();
  const leg = await gateway.dial('+79991112233');
  const received: Buffer[] = [];
  await leg.startMedia(audio => received.push(audio));
  const originate = ari.requests.find(r => r.url.pathname === '/ari/channels')!;
  assert.equal(originate.url.searchParams.get('appArgs'), 'outbound');
  assert.equal(originate.url.searchParams.get('endpoint'), 'Local/+79991112233@gpt-outbound/n');
  const external = ari.requests.find(r => r.url.pathname.endsWith('/externalMedia'))!.url;
  for (const [key, value] of Object.entries({transport: 'websocket', encapsulation: 'none', external_host: 'INCOMING', connection_type: 'server', format: 'slin24'})) assert.equal(external.searchParams.get(key), value);
  ari.media!.send(Buffer.from([1, 0, 2, 0]));
  await until(() => received.length === 1); assert.deepEqual(received[0], Buffer.from([1, 0, 2, 0]));
  ari.media!.send('MEDIA_XOFF'); await new Promise(resolve => setTimeout(resolve, 15));
  const audio = Buffer.alloc(130000, 7);
  leg.sendAudio(audio); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(ari.mediaMessages.filter(m => m.binary).length, 0);
  ari.media!.send('MEDIA_XON'); await until(() => Buffer.concat(ari.mediaMessages.filter(m => m.binary).map(m => m.data)).length === audio.length);
  assert.deepEqual(Buffer.concat(ari.mediaMessages.filter(m => m.binary).map(m => m.data)), audio);
  assert.ok(ari.mediaMessages.filter(m => m.binary).every(m => m.data.length < 65500));
  assert.equal(ari.mediaMessages.filter(m => !m.binary && m.data.toString() === 'START_MEDIA_BUFFERING').length, 1);
  assert.ok(!ari.mediaMessages.some(m => !m.binary && m.data.toString().startsWith('STOP_MEDIA_BUFFERING')));
  assert.ok(ari.requests.every(r => r.authorization?.startsWith('Basic ') && !r.url.searchParams.has('api_key') && !r.url.username));
  await leg.close(); assert.equal(ari.channels.size, 0); assert.equal(ari.bridges.size, 0);
});

test('incoming is answered only when media is ready; media failure hangs up every channel', async t => {
  const ari = await fakeAri({failMedia: true}); t.after(() => ari.close());
  const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
  const incoming = once(gateway, 'incoming'); ari.channels.add('inbound-test');
  ari.emit({type: 'StasisStart', args: ['incoming'], channel: {id: 'inbound-test', caller: {number: '+79993334455'}}});
  const [leg, number] = await incoming as [PhoneLeg, string]; assert.equal(number, '+79993334455');
  assert.ok(!ari.requests.some(r => r.url.pathname.endsWith('/answer')));
  await assert.rejects(leg.startMedia(() => {}), /ARI|media/i);
  assert.equal(ari.channels.size, 0); assert.equal(ari.bridges.size, 0);
});

test('failed originate and cancellation while ringing clean up deterministic channels', async t => {
  for (const options of [{failDial: true}, {delayDial: true}, {delayDial: true, lateOriginate: true}]) {
    const ari = await fakeAri(options); t.after(() => ari.close());
    const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
    const abort = new AbortController();
    const dial = gateway.dial('+79991112233', abort.signal);
    const rejected = assert.rejects(dial, /ARI|cancel|closed|abort/i);
    if (options.delayDial) {await until(() => !!ari.dialId); abort.abort();}
    await rejected; assert.equal(ari.channels.size, 0);
  }
});

test('incoming answer follows media bridge setup and remote hangup removes media and bridge', async t => {
  const ari = await fakeAri(); t.after(() => ari.close());
  const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
  const incoming = once(gateway, 'incoming'); ari.channels.add('inbound-test');
  ari.emit({type: 'StasisStart', args: ['incoming'], channel: {id: 'inbound-test', caller: {number: '+79993334455'}}});
  const [leg] = await incoming as [PhoneLeg]; await leg.startMedia(() => {});
  const answerIndex = ari.requests.findIndex(r => r.url.pathname.endsWith('/answer'));
  assert.ok(answerIndex > ari.requests.findLastIndex(r => r.url.pathname.endsWith('/addChannel')));
  const recordingIndex=ari.requests.findIndex(r=>r.url.pathname.endsWith('/record'));
  assert.ok(recordingIndex>=0&&recordingIndex<answerIndex);
  assert.ok(leg.recordingPath?.endsWith('.wav'));
  const hangup = once(gateway, 'hangup'); ari.channels.delete('inbound-test');
  ari.emit({type: 'StasisEnd', channel: {id: 'inbound-test'}}); await hangup;
  assert.equal(ari.channels.size, 0); assert.equal(ari.bridges.size, 0);
  assert.ok(ari.requests.some(r=>r.method==='POST'&&r.url.pathname.startsWith('/ari/recordings/live/')&&r.url.pathname.endsWith('/stop')));
});

test('missing media ID and output overflow fail closed without silently losing audio', async t => {
  for (const options of [{noConnectionId: true}, {}]) {
    const ari = await fakeAri(options); t.after(() => ari.close());
    const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
    const leg = await gateway.dial('+79991112233');
    if ('noConnectionId' in options) await assert.rejects(leg.startMedia(() => {}), /connection ID/i);
    else {
      await leg.startMedia(() => {}); const errors: Error[] = []; gateway.on('error', error => errors.push(error));
      const hangup = once(gateway, 'hangup'); leg.sendAudio(Buffer.alloc(240002));
      // once() rejects for an error event, so wait for cleanup directly here.
      void hangup.catch(() => {});
      await until(() => ari.channels.size === 0 && ari.bridges.size === 0);
      assert.match(errors[0]!.message, /queue/i);
    }
    assert.equal(ari.channels.size, 0); assert.equal(ari.bridges.size, 0);
  }
});

test('event transport failure hangs up calls without an error listener', async t => {
  const ari = await fakeAri(); t.after(() => ari.close());
  const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
  await gateway.dial('+79991112233'); ari.events!.terminate();
  await until(() => ari.channels.size === 0);
});

test('invalid ARI credential URLs and dial injection are rejected before network access', async t => {
  const ari = await fakeAri(); t.after(() => ari.close());
  assert.throws(() => new AsteriskGateway({...ari.config, ariUrl: 'http://user:secret@localhost:8088'}), /URL|credentials/i);
  const gateway = new AsteriskGateway(ari.config); t.after(() => gateway.close()); await gateway.connect();
  await assert.rejects(gateway.dial('+7999@gateway'), /number/i);
  assert.ok(!ari.requests.some(r => r.url.pathname === '/ari/channels'));
});

test('caller speech flushes queued playback, suppresses overlap and resumes after silence', async t=>{
  const ari=await fakeAri();t.after(()=>ari.close());const gateway=new AsteriskGateway(ari.config);t.after(()=>gateway.close());await gateway.connect();
  const leg=await gateway.dial('+79991112233');await leg.startMedia(()=>{});let interruptions=0;gateway.on('interrupted',()=>interruptions++);
  ari.emit({type:'ChannelTalkingStarted',channel:{id:ari.mediaId}});
  ari.media!.send('MEDIA_XOFF');await new Promise(r=>setTimeout(r,10));leg.sendAudio(Buffer.alloc(960,1));
  ari.emit({type:'ChannelTalkingStarted',channel:{id:ari.dialId}});
  await until(()=>ari.mediaMessages.some(m=>!m.binary&&m.data.toString()==='FLUSH_MEDIA'));
  leg.sendAudio(Buffer.alloc(960,2));ari.media!.send('MEDIA_XON');await new Promise(r=>setTimeout(r,20));assert.equal(ari.mediaMessages.filter(m=>m.binary).length,0);assert.equal(interruptions,1);
  ari.emit({type:'ChannelTalkingFinished',channel:{id:ari.dialId}});await new Promise(r=>setTimeout(r,10));leg.sendAudio(Buffer.alloc(960,3));await until(()=>ari.mediaMessages.some(m=>m.binary));
  assert.ok(ari.mediaMessages.filter(m=>m.binary).every(m=>m.data.every(v=>v===3)));await leg.close();
});

test('config generation uses a strict dialplan and rejects config/host/credential injection', () => {
  const env = {PLUSOFON_SIP_HOST: 'sip.example.test', PLUSOFON_SIP_USERNAME: 'sip-user', PLUSOFON_SIP_PASSWORD: 'private-password', PLUSOFON_CALLER_NUMBER: '+79990000000', ASTERISK_ARI_USERNAME: 'phone', ASTERISK_ARI_PASSWORD: 'private-test-password'};
  const files = renderAsteriskConfig(env);
  assert.match(files['pjsip.conf']!, /protocol=tcp/);
  assert.doesNotMatch(files['pjsip.conf']!, /transport-udp/);
  assert.match(files['extensions.conf']!, /Stasis\(gpt-live-phone,incoming\)/);
  assert.match(files['extensions.conf']!, /b\(gpt-charge\^s\^1\)/);
  assert.match(files['extensions.conf']!, /PJSIP_HEADER\(add,P-Charge-Info\)/);
  assert.match(files['extensions.conf']!, /<sip:79990000000@voice\.plusofon\.ru>/);
  assert.match(files['rtp.conf']!, /rtpend=10020/);
  assert.match(files['http.conf']!, /bindaddr=127\.0\.0\.1/);
  assert.match(files['modules.conf']!, /chan_websocket\.so/);
  const offline = renderAsteriskConfig({ASTERISK_ARI_USERNAME: 'phone', ASTERISK_ARI_PASSWORD: 'private-test-password', ASTERISK_HTTP_BIND_ADDRESS: '0.0.0.0'});
  assert.doesNotMatch(offline['pjsip.conf']!, /type=registration/);
  assert.doesNotMatch(offline['extensions.conf']!, /Dial\(PJSIP/);
  assert.match(offline['extensions.conf']!, /\[gpt-test\][\s\S]*Echo\(\)/);
  assert.match(offline['http.conf']!, /bindaddr=0\.0\.0\.0/);
  for (const replacement of [{PLUSOFON_SIP_HOST: 'example.test\n#include bad'}, {PLUSOFON_SIP_HOST: 'sip://example.test'}, {PLUSOFON_SIP_USERNAME: 'x@bad'}, {PLUSOFON_SIP_PASSWORD: 'x;truncated'}, {PLUSOFON_SIP_PASSWORD: '<redacted>'}, {ASTERISK_ARI_PASSWORD: 'REDACTED'}, {ASTERISK_ARI_PASSWORD: 'x\n[evil]'}, {PLUSOFON_CALLER_NUMBER: '+700;bad'}]) {
    assert.throws(() => renderAsteriskConfig({...env, ...replacement}), /invalid|must|required/i);
  }
});
