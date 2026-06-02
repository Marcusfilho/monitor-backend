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
function send(name, params, mtkn) {
  ws.send(encodeURIComponent(JSON.stringify({
    action: { flow_id:'1', name,
      parameters: { _action_name:name, mtkn, ...params },
      session_token: token, mtkn }
  })));
}
function wait(ms) { return new Promise(r=>setTimeout(r,ms)); }
ws.on('message', (raw) => {
  const text = raw.toString();
  const decoded = text.startsWith('%7B') ? decodeURIComponent(text) : text;
  try {
    const p = JSON.parse(decoded.replace(/\x00/g,'')).response.properties;
    if (p.action_name === 'get_unit_parameters_opr') {
      console.log('OPR params (' + p.data.length + '):');
      p.data.forEach(d => console.log('  id=' + d.id + ' descr=' + decodeURIComponent(d.param_type_descr||'')));
    } else if (p.action_name === 'get_unit_parameters_metadata') {
      console.log('METADATA params (' + p.data.length + '):');
      p.data.slice(0,5).forEach(d => console.log('  id=' + d.id + ' source=' + d.source + ' convertion=' + d.convertion_type));
    } else {
      console.log('IN:', p.action_name, 'av='+p.action_value);
    }
  } catch(e) {}
});
ws.on('open', async () => {
  send('vehicle_subscribe', { vehicle_id:'1940478', object_type:'UNIT_PARAMETERS' }, 'S1');
  await wait(800);
  send('get_unit_parameters_opr', { filter:'', vehicle_id:'1940478' }, 'O1');
  await wait(1500);
  send('get_unit_parameters_metadata', { filter:'', vehicle_id:'1940478' }, 'M1');
  setTimeout(()=>ws.close(), 8000);
});
ws.on('close', ()=>console.log('fechado'));
