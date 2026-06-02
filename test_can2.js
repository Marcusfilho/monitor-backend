const WebSocket = require('ws');
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('/home/questar/monitor-backend-rewrite/worker_secrets_rw.env','utf8')
    .split('\n').filter(l=>l.includes('=')).map(l=>l.split('='))
    .map(([k,...v])=>[k.trim(), v.join('=').trim()])
);
const token = fs.readFileSync('/tmp/.session_token_can','utf8').trim();
const guid  = env.MONITOR_WS_GUID;
const url   = `wss://websocket.traffilog.com:8182/${guid}/${token}/json?defragment=1`;
const UNIT_KEY   = 'SPT%3A0000000913018234';
const VEHICLE_ID = '1940478';

const ws = new WebSocket(url, { origin: 'https://operation.traffilog.com', handshakeTimeout: 15000 });

let seq = 1;
function send(name, params) {
  const mtkn = String(seq++);
  const payload = JSON.stringify({
    action: { flow_id: String(seq), name,
      parameters: { _action_name: name, mtkn, ...params },
      session_token: token, mtkn }
  });
  ws.send(encodeURIComponent(payload));
  console.log('OUT:', name);
}

// Imprime TUDO que chega — raw e decodificado
ws.on('message', (raw) => {
  const text = raw.toString();
  const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
  const clean = decoded.replace(/\x00/g, '');
  try {
    const j = JSON.parse(clean);
    const p = j.response && j.response.properties;
    if (p) {
      const an = p.action_name || '';
      const ds = p.data_source || '';
      const av = p.action_value || '';
      const dlen = (p.data || []).length;
      console.log(`IN: action=${an} ds=${ds} av=${av} data_len=${dlen}`);
      if (ds === 'UNIT_PARAMETERS' || an === 'send_quick_command') {
        console.log('  DATA[0]:', JSON.stringify((p.data||[])[0]||{}).substring(0,200));
      }
    } else {
      console.log('IN (sem props):', clean.substring(0, 150));
    }
  } catch(e) {
    console.log('IN parse err:', clean.substring(0, 150));
  }
});

ws.on('open', async () => {
  console.log('conectado, iniciando sequência...');
  send('vehicle_unsubscribe', { vehicle_id: VEHICLE_ID, object_type: '' });
  await new Promise(r => setTimeout(r, 800));
  send('vehicle_subscribe', { vehicle_id: VEHICLE_ID, object_type: 'UNIT_PARAMETERS' });
  await new Promise(r => setTimeout(r, 800));
  send('get_unit_parameters_opr', { filter: '', vehicle_id: VEHICLE_ID });
  await new Promise(r => setTimeout(r, 1500));
  send('get_unit_parameters_metadata', { filter: '', vehicle_id: VEHICLE_ID });
  await new Promise(r => setTimeout(r, 2000));
  send('send_quick_command', { unit_key: UNIT_KEY, local_action_id: '5', cmd_id: '9', ack_needed: '0' });
  console.log('aguardando 30s...');
  setTimeout(() => { console.log('encerrando'); ws.close(); }, 30000);
});

ws.on('error', e => console.error('ERRO:', e.message));
ws.on('close', () => console.log('fechado'));
