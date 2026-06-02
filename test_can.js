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

function send(name, params, mtkn) {
  const frame = encodeURIComponent(JSON.stringify({
    action: { flow_id:'111111', name,
      parameters: { _action_name:name, mtkn, ...params },
      session_token: token, mtkn }
  }));
  ws.send(frame);
}

ws.on('open', async () => {
  console.log('conectado');
  send('vehicle_unsubscribe', { vehicle_id: VEHICLE_ID, object_type: '' }, '111001');
  await new Promise(r=>setTimeout(r,500));
  send('vehicle_subscribe', { vehicle_id: VEHICLE_ID, object_type: 'UNIT_PARAMETERS' }, '111002');
  await new Promise(r=>setTimeout(r,500));
  send('get_unit_parameters_opr', { filter:'', vehicle_id: VEHICLE_ID }, '111003');
  await new Promise(r=>setTimeout(r,1000));
  send('get_unit_parameters_metadata', { filter:'', vehicle_id: VEHICLE_ID }, '111004');
  await new Promise(r=>setTimeout(r,2000));
  console.log('enviando send_quick_command...');
  send('send_quick_command', { unit_key: UNIT_KEY, local_action_id:'5', cmd_id:'9', ack_needed:'0' }, '111005');
  setTimeout(()=>{ console.log('encerrando'); ws.close(); }, 30000);
});

ws.on('message', (raw) => {
  const text = raw.toString().startsWith('%7B') ? decodeURIComponent(raw.toString()) : raw.toString();
  try {
    const j = JSON.parse(text.replace(/\x00/g,''));
    const p = j && j.response && j.response.properties;
    if (!p) return;
    const ds = p.data_source || '';
    const an = p.action_name || '';
    if (an === 'refresh' && ds === 'UNIT_PARAMETERS') {
      console.log('>>> UNIT_PARAMETERS chegou! count=' + (p.data ? p.data.length : 0));
    } else if (an === 'refresh') {
      console.log('refresh ds=' + ds);
    } else {
      console.log('ACTION:', an, 'av=' + p.action_value, JSON.stringify(p.data && p.data[0] || {}).substring(0,150));
    }
  } catch(e) {}
});
ws.on('error', function(e) { console.error('ERRO:', e.message); });
ws.on('close', function() { console.log('fechado'); });
