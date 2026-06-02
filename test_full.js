const WebSocket = require('ws');
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('/home/questar/monitor-backend-rewrite/worker_secrets_rw.env','utf8')
    .split('\n').filter(l=>l.includes('=')).map(l=>l.split('='))
    .map(([k,...v])=>[k.trim(), v.join('=').trim()])
);

async function main() {
  // Login fresh
  const loginRes = await fetch(env.TRAFFILOG_API_BASE_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:{ name:'user_login', parameters:{ login_name: env.WS_LOGIN_NAME, password: env.WS_PASSWORD }}})
  });
  const loginData = await loginRes.json();
  const token = loginData?.response?.properties?.session_token
             || loginData?.response?.properties?.data?.[0]?.session_token;
  console.log('token len:', token?.length);
  if (!token) { console.error('LOGIN FALHOU', JSON.stringify(loginData)); return; }

  const url = `wss://websocket.traffilog.com:8182/${env.MONITOR_WS_GUID}/${token}/json?defragment=1`;
  const ws = new WebSocket(url, { origin: 'https://operation.traffilog.com', handshakeTimeout: 15000 });

  let seq = 1;
  function send(name, params) {
    const mtkn = 'T' + (seq++);
    ws.send(encodeURIComponent(JSON.stringify({
      action: { flow_id: String(seq), name,
        parameters: { _action_name:name, mtkn, ...params },
        session_token: token, mtkn }
    })));
    console.log('OUT:', name, mtkn);
  }
  function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }

  ws.on('message', (raw) => {
    const text = raw.toString();
    const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
    try {
      const p = JSON.parse(decoded.replace(/\x00/g,'')).response.properties;
      const an = p.action_name||'', ds = p.data_source||'';
      if (an === 'get_unit_parameters_opr') {
        console.log('OPR (' + p.data.length + ' params):');
        p.data.forEach(d => console.log('  '+d.id, decodeURIComponent(d.param_type_descr||'')));
      } else if (an === 'refresh' && ds === 'UNIT_PARAMETERS') {
        console.log('>>> UNIT_PARAMETERS count='+p.data.length, JSON.stringify(p.data[0]).substring(0,120));
      } else if (an === 'refresh') {
        console.log('  refresh ds='+ds);
      } else {
        console.log('IN:', an, 'av='+p.action_value, 'len='+(p.data||[]).length);
      }
    } catch(e) {}
  });

  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', async () => {
      console.log('WS conectado');
      send('vehicle_unsubscribe',          { vehicle_id:'1940478', object_type:'' });
      await wait(600);
      send('vehicle_subscribe',            { vehicle_id:'1940478', object_type:'UNIT_MESSAGES' });
      await wait(400);
      send('vehicle_subscribe',            { vehicle_id:'1940478', object_type:'UNIT_CONFIG_STATUS', value:'' });
      await wait(400);
      send('vehicle_subscribe',            { vehicle_id:'1940478', object_type:'UNIT_PARAMETERS' });
      await wait(400);
      send('get_unit_parameters_opr',      { filter:'', vehicle_id:'1940478' });
      await wait(1200);
      send('get_unit_parameters_metadata', { filter:'', vehicle_id:'1940478' });
      await wait(1200);
      send('get_monitor_module_state',     { tag:'loading_screen', filter:'', vehicle_id:'1940478' });
      await wait(2000);
      console.log('--- send_quick_command ---');
      send('send_quick_command', { unit_key:'SPT%3A0000000913018234', local_action_id:'5', cmd_id:'9', ack_needed:'0' });
      setTimeout(() => { ws.close(); resolve(null); }, 40000);
    });
  });
}

main().catch(console.error);
