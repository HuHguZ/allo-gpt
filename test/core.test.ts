import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig, normalizeNumber, liveIssues, safeText, safeError} from '../src/config.js';
import {CallStore, addTranscript} from '../src/store.js';
import type {CallRecord} from '../src/types.js';

test('manual Russian numbers normalize; dialplan injection and bad limits are rejected', () => {
  assert.equal(normalizeNumber('8 (999) 123-45-67'), '+79991234567');
  assert.throws(() => normalizeNumber('+79991234567;System(calc)'));
  assert.throws(() => normalizeNumber('+12025550100'));
  assert.throws(() => loadConfig({MAX_CALL_SECONDS: 'NaN'}));
  assert.throws(() => loadConfig({PHONE_MODE: 'liv'}));
  assert.equal(loadConfig({}).mode, 'demo');
  assert.ok(liveIssues(loadConfig({})).some(s => s.includes('OPENAI_API_KEY')));
});

test('remote text cannot inject terminal escapes, and secrets are redacted from errors', () => {
  assert.equal(safeText('\x1b[31mhi\x1b[0m\x1b]52;c;YWJj\x07\rX'), 'hiX');
  assert.equal(safeError(new Error('failed sk-secret'), ['sk-secret']), 'failed [скрыто]');
});

test('overlapping and out-of-order transcript fragments preserve roles, spaces and timing', () => {
  const entries: CallRecord['entries'] = [];
  addTranscript(entries, {role:'agent', text:'Привет', startMs:1000,endMs:1300});
  addTranscript(entries, {role:'human', text:'Да', startMs:1100,endMs:1400});
  addTranscript(entries, {role:'agent', text:'!', startMs:1300,endMs:1350});
  addTranscript(entries, {role:'human', text:'Сначала ', startMs:0,endMs:300});
  assert.equal(entries[0]?.text, 'Сначала ');
  assert.equal(entries[1]?.text, 'Привет!');
  assert.equal(entries[2]?.role, 'human');
  assert.throws(() => addTranscript(entries, {role:'human',text:'bad',startMs:-1,endMs:0}));
});

test('call exports are durable and a restart exposes interrupted calls honestly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-store-'));
  try {
    const store = new CallStore(dir);
    const record: CallRecord = {id:'call-safe',direction:'demo',number:'+70000000000',task:'Проверка',startedAt:new Date().toISOString(),status:'active',entries:[{role:'human',text:'Привет',startMs:100,endMs:400}],closeConfirmed:false};
    await store.save(record);
    const history = await store.load();
    assert.equal(history[0]?.status, 'failed');
    assert.match(history[0]?.error ?? '', /прерван/);
    assert.match(await readFile(join(dir,'call-safe','transcript.txt'),'utf8'), /Собеседник: Привет/);
    assert.throws(() => store.directory('../escape'));
    const json = JSON.parse(await readFile(join(dir,'call-safe','call.json'),'utf8'));
    assert.equal(json.entries[0].role, 'human');
  } finally { await rm(dir, {recursive:true,force:true}); }
});
