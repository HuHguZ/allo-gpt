import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function renderAsteriskConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const required = (name: string): string => {
    const value = env[name] ?? '';
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const identifier = (name: string, fallback?: string): string => {
    const value = env[name] || fallback || required(name);
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} is invalid`);
    return value;
  };
  const secret = (name: string): string => {
    const value = required(name);
    if (/^(?:<redacted>|redacted)$/i.test(value)) throw new Error(`${name} is invalid: redacted placeholder; enter the actual credential`);
    if (!/^[\x21-\x7e]+$/.test(value) || /[;#\[\]\\]/.test(value)) throw new Error(`${name} is invalid for an Asterisk config value`);
    return value;
  };
  const host = (name: string, optional = false): string => {
    const value = optional ? env[name] ?? '' : required(name);
    if (value && (value.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) || value.includes('..'))) throw new Error(`${name} must be a hostname or IPv4 address, without a scheme or port`);
    return value;
  };
  const sipHost = host('PLUSOFON_SIP_HOST', true);
  const username = env.PLUSOFON_SIP_USERNAME ?? '';
  if (username && !/^[A-Za-z0-9_.+-]+$/.test(username)) throw new Error('PLUSOFON_SIP_USERNAME is invalid');
  const password = env.PLUSOFON_SIP_PASSWORD ? secret('PLUSOFON_SIP_PASSWORD') : '';
  const caller = env.PLUSOFON_CALLER_NUMBER ?? '';
  if (caller && !/^\+7\d{10}$/.test(caller)) throw new Error('PLUSOFON_CALLER_NUMBER must be your connected +7 number');
  const providerReady = !!(sipHost && username && password && caller);
  const ariUser = identifier('ASTERISK_ARI_USERNAME', 'phone');
  const ariPassword = secret('ASTERISK_ARI_PASSWORD');
  const app = identifier('ASTERISK_APP', 'gpt-live-phone');
  const trunk = identifier('ASTERISK_TRUNK', 'plusofon');
  const ariUrl = new URL(env.ASTERISK_ARI_URL || 'http://127.0.0.1:8088');
  if (ariUrl.protocol !== 'http:' || ariUrl.username || ariUrl.password || ariUrl.search || ariUrl.hash || !['', '/', '/ari', '/ari/'].includes(ariUrl.pathname)) throw new Error('ASTERISK_ARI_URL must be an HTTP URL without credentials; use an SSH tunnel for this local HTTP config');
  const httpPort = ariUrl.port || '80';
  const httpBind = env.ASTERISK_HTTP_BIND_ADDRESS || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(httpBind)) throw new Error('ASTERISK_HTTP_BIND_ADDRESS must be 127.0.0.1 or 0.0.0.0');
  const external = host('ASTERISK_EXTERNAL_ADDRESS', true);
  const jitterBufferMs=Number(env.ASTERISK_JITTERBUFFER_MS||'120');
  if(!Number.isInteger(jitterBufferMs)||jitterBufferMs<40||jitterBufferMs>400||jitterBufferMs%20)throw new Error('ASTERISK_JITTERBUFFER_MS must be 40-400 milliseconds in steps of 20');
  const nat = external ? `external_signaling_address=${external}\nexternal_media_address=${external}\nlocal_net=10.0.0.0/8\nlocal_net=172.16.0.0/12\nlocal_net=192.168.0.0/16\n` : '';
  return {
    'pjsip.conf': `[transport-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:5060
${nat}
${providerReady ? `[${trunk}-auth]
type=auth
auth_type=userpass
username=${username}
password=${password}

[${trunk}-aor]
type=aor
contact=sip:${sipHost}:5060
outbound_proxy=sip:${sipHost}:5060\\;lr
qualify_frequency=60

[${trunk}]
type=endpoint
transport=transport-tcp
context=gpt-incoming
disallow=all
allow=alaw,ulaw
outbound_auth=${trunk}-auth
aors=${trunk}-aor
outbound_proxy=sip:${sipHost}:5060\\;lr
from_user=${username}
from_domain=${sipHost}
callerid=${username}
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
dtmf_mode=rfc4733

[${trunk}-registration]
type=registration
transport=transport-tcp
outbound_auth=${trunk}-auth
server_uri=sip:${sipHost}:5060
client_uri=sip:${username}@${sipHost}
outbound_proxy=sip:${sipHost}:5060\\;lr
contact_user=${username}
retry_interval=60
auth_rejection_permanent=no
forbidden_retry_interval=5
expiration=300
line=yes
endpoint=${trunk}

[${trunk}-identify]
type=identify
endpoint=${trunk}
match=${sipHost}
` : '; SIP credentials incomplete: provider registration and outbound calls are disabled.\n'}
`,
    'extensions.conf': `[general]
static=yes
writeprotect=yes

[default]
exten => _.,1,Hangup()

[gpt-incoming]
exten => _X.,1,Set(JITTERBUFFER(fixed)=${jitterBufferMs})
 same => n,Stasis(${app},incoming)
 same => n,Hangup()
exten => s,1,Set(JITTERBUFFER(fixed)=${jitterBufferMs})
 same => n,Stasis(${app},incoming)
 same => n,Hangup()

[gpt-outbound]
${providerReady ? `exten => _+7XXXXXXXXXX,1,Set(CALLERID(num)=${caller})
 same => n,Dial(PJSIP/\${EXTEN:1}@${trunk},60,b(gpt-charge^s^1))
 same => n,Hangup()

[gpt-charge]
exten => s,1,Set(JITTERBUFFER(fixed)=${jitterBufferMs})
 same => n,Set(PJSIP_HEADER(add,P-Charge-Info)=<sip:${caller.slice(1)}@voice.plusofon.ru>)
 same => n,Return()
` : 'exten => _.,1,Hangup(21)\n'}

[gpt-test]
exten => echo,1,Answer()
 same => n,Echo()
 same => n,Hangup()
`,
    'ari.conf': `[general]
enabled=yes
pretty=no
channelvars=MEDIA_WEBSOCKET_CONNECTION_ID,MEDIA_WEBSOCKET_OPTIMAL_FRAME_SIZE

[${ariUser}]
type=user
read_only=no
password_format=plain
password=${ariPassword}
`,
    'http.conf': `[general]
enabled=yes
bindaddr=${httpBind}
bindport=${httpPort}
`,
    'rtp.conf': `[general]
rtpstart=10000
rtpend=10020
strictrtp=yes
`,
    'modules.conf': `[modules]
autoload=yes
load=chan_websocket.so
load=res_http_websocket.so
load=res_ari.so
load=res_ari_channels.so
load=res_ari_bridges.so
load=res_ari_events.so
load=codec_resample.so
`,
    'chan_websocket.conf': `[global]
control_message_format=plain-text
`,
  };
}

async function main(): Promise<void> {
  try {process.loadEnvFile(resolve('.env'));}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read .env');}
  const files = renderAsteriskConfig(process.env);
  const directory = resolve('runtime', 'asterisk');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await mkdir(resolve('recordings'), {recursive: true, mode: 0o700});
  for (const [filename, content] of Object.entries(files)) await writeFile(resolve(directory, filename), content, {encoding: 'utf8', mode: 0o600});
  console.log('Generated seven private Asterisk configuration files in runtime/asterisk. The generator does not install or start Asterisk. See infra/README.md.');
  if (!['PLUSOFON_SIP_HOST', 'PLUSOFON_SIP_USERNAME', 'PLUSOFON_SIP_PASSWORD', 'PLUSOFON_CALLER_NUMBER'].every(name => process.env[name])) console.log('SIP credentials incomplete: provider registration and outbound calls are disabled; local echo testing is available.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error && !/invalid url/i.test(error.message) ? error.message : 'Invalid Asterisk configuration');
    process.exitCode = 1;
  });
}
