const https = require('https');
const WebSocket = require('ws');

const API_URL    = 'https://api-il.traffilog.com/appengine_3/5E1DCD81-5138-4A35-B271-E33D71FFFFD9/1/json';
const GUID       = '7E65FBE2-993A-489E-A445-13E9E5CBFF02';
const VEHICLE_ID = '1987068';
const CLIENT_ID  = '219411';

function httpPost(body) {
  return new Promise((res, rej) => {
    const b = JSON.stringify(body);
    const req = https.request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
    }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej); req.write(b); req.end();
  });
}

(async () => {
  const login = await httpPost({ action: { name: 'user_login', parameters: { login_name: 'Marcus_Prod', password: 'Questar@2026!' } } });
  const tok = login?.response?.properties?.session_token;
  console.log('TOKEN:', tok?.slice(0, 10) + '...');

  const ws = new WebSocket(`wss://websocket.traffilog.com:8182/${GUID}/${tok}/json?defragment=1`, {
    headers: {
      'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9'
    },
    origin: 'https://operation.traffilog.com',
    handshakeTimeout: 15000,
    perMessageDeflate: { clientMaxWindowBits: 15 }
  });

  let seq = 100;
  function send(name, params) {
    const mtkn = String(seq++);
    ws.send(encodeURIComponent(JSON.stringify({
      action: { flow_id: String(seq), name, parameters: { _action_name: name, mtkn, ...params }, session_token: tok, mtkn }
    })));
    console.log('OUT:', name);
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  ws.on('message', raw => {
    const text = raw.toString();
    const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
    try {
      const p = JSON.parse(decoded.replace(/\x00/g, ''))?.response?.properties;
      if (!p) return;
      const an = p.action_name || '', ds = p.data_source || '';
      if (an === 'refresh' && ds === 'UNIT_PARAMETERS')
        console.log('>>> UNIT_PARAMETERS count=' + (p.data || []).length, 'sample=' + JSON.stringify((p.data || [])[0] || {}).slice(0, 150));
      else if (an === 'refresh')
        console.log('  refresh ds=' + ds + ' data_len=' + (p.data || []).length);
      else
        console.log('IN:', an, 'av=' + p.action_value, 'data_len=' + (p.data || []).length);
    } catch (e) {}
  });

  ws.on('open', async () => {
    console.log('WS OPEN');
    send('get_vehicle_info',             { tag: 'loading_screen', vehicle_id: VEHICLE_ID, client_id: CLIENT_ID });
    await wait(1000);
    send('get_vehicle_data_from_redis',  { vehicle_id: VEHICLE_ID });
    await wait(800);
    send('vehicle_unsubscribe',          { vehicle_id: VEHICLE_ID, object_type: '' });
    await wait(500);
    send('vehicle_subscribe',            { vehicle_id: VEHICLE_ID, object_type: 'UNIT_MESSAGES' });
    await wait(500);
    send('vehicle_subscribe',            { vehicle_id: VEHICLE_ID, object_type: 'UNIT_CONFIG_STATUS', value: '' });
    await wait(500);
    send('vehicle_subscribe',            { vehicle_id: VEHICLE_ID, object_type: 'UNIT_PARAMETERS' });
    await wait(500);
    send('get_unit_parameters_opr',      { filter: '', vehicle_id: VEHICLE_ID });
    await wait(1000);
    send('get_unit_parameters_metadata', { filter: '', vehicle_id: VEHICLE_ID });
    await wait(1000);
    send('get_monitor_module_state',     { tag: 'loading_screen', filter: '', vehicle_id: VEHICLE_ID });
    await wait(2000);
    console.log('--- sequência completa, aguardando dados CAN... ---');
    setTimeout(() => { console.log('encerrando'); ws.close(); }, 20000);
  });

  ws.on('error', e => console.log('ERROR:', e.message));
  ws.on('close', () => console.log('WS fechado'));
})();
