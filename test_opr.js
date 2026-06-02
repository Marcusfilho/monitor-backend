const WebSocket = require('ws');
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('/home/questar/monitor-backend-rewrite/worker_secrets_rw.env','utf8')
    .split('\n').filter(l=>l.includes('=')).map(l=>l.split('='))
    .map(([k,...v])=>[k.trim(), v.join('=').trim()])
);
const token = fs.readFileSync('/tmp/.session_token_can','utf8').trim();
const url = `wss://websocket.traffilog.com:8182/${env.MONITOR_WS_GUID}/${token}/json?defragment=1`;
const ws = new WebSocket(url, { origin: 'https://operation.traffilog.com', handshakeTimeout: 15000 });

ws.on('message', (raw) => {
  const text = raw.toString();
  const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
  try {
    const p = JSON.parse(decoded.replace(/\x00/g,'')).response.properties;
    if (p.action_name === 'get_unit_parameters_opr') {
      console.log('opr data_len:', p.data.length);
      p.data.forEach(d => console.log(' ', d.id, d.param_type_descr));
    }
  } catch(e) {}
});

ws.on('open', async () => {
  ws.send(encodeURIComponent(JSON.stringify({
    action: { flow_id:'1', name:'get_unit_parameters_opr',
      parameters: { _action_name:'get_unit_parameters_opr', mtkn:'X1', filter:'', vehicle_id:'1940478' },
      session_token: token, mtkn:'X1' }
  })));
  setTimeout(()=>ws.close(), 6000);
});
ws.on('close', ()=>console.log('fechado'));
