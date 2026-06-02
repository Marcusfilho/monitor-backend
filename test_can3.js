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

let seq = 100;
function send(name, params) {
  const mtkn = String(seq++);
  ws.send(encodeURIComponent(JSON.stringify({
    action: { flow_id: String(seq), name,
      parameters: { _action_name: name, mtkn, ...params },
      session_token: token, mtkn }
  })));
  console.log('OUT:', name, mtkn);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

ws.on('message', (raw) => {
  const text = raw.toString();
  const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
  try {
    const p = JSON.parse(decoded.replace(/\x00/g,'')).response.properties;
    const an = p.action_name || '', ds = p.data_source || '';
    if (an === 'refresh' && ds === 'UNIT_PARAMETERS') {
      console.log('>>> UNIT_PARAMETERS! count=' + (p.data||[]).length, 'sample='+JSON.stringify((p.data||[])[0]||{}).substring(0,100));
    } else if (an === 'refresh') {
      console.log('  refresh ds=' + ds + ' data_len=' + (p.data||[]).length);
    } else {
      console.log('IN:', an, 'av='+p.action_value, 'data_len='+(p.data||[]).length);
    }
  } catch(e) {}
});

ws.on('open', async () => {
  console.log('conectado — sequência COMPLETA igual ao serviço');

  // Sequência exata do vehicleMonitorSnapshotService
  send('get_vehicle_info',            { tag:'loading_screen', vehicle_id: VEHICLE_ID });
  await wait(1000);
  send('get_vehicle_data_from_redis', { vehicle_id: VEHICLE_ID });
  await wait(800);
  send('vehicle_unsubscribe',         { vehicle_id: VEHICLE_ID, object_type: '' });
  await wait(500);
  send('vehicle_subscribe',           { vehicle_id: VEHICLE_ID, object_type: 'UNIT_MESSAGES' });
  await wait(500);
  send('vehicle_subscribe',           { vehicle_id: VEHICLE_ID, object_type: 'UNIT_CONFIG_STATUS', value: '' });
  await wait(500);
  send('vehicle_subscribe',           { vehicle_id: VEHICLE_ID, object_type: 'UNIT_PARAMETERS' });
  await wait(500);
  send('get_unit_parameters_opr',     { filter: '', vehicle_id: VEHICLE_ID });
  await wait(1000);
  send('get_unit_parameters_metadata',{ filter: '', vehicle_id: VEHICLE_ID });
  await wait(1000);
  send('get_monitor_module_state',    { tag:'loading_screen', filter:'', vehicle_id: VEHICLE_ID });
  await wait(2000);
  console.log('--- enviando send_quick_command ---');
  send('send_quick_command', { unit_key: UNIT_KEY, local_action_id:'5', cmd_id:'9', ack_needed:'0' });

  setTimeout(() => { console.log('encerrando'); ws.close(); }, 40000);
});

ws.on('error', e => console.error('ERRO:', e.message));
ws.on('close', () => console.log('fechado'));
