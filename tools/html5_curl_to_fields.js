"use strict";

/**
 * Converte um "Copy as cURL" do DevTools (com -d / --data-raw) em JSON de fields.
 * Uso:
 *   node tools/html5_curl_to_fields.js /tmp/curl.txt
 * Saída:
 *   {"fields":{...},"hint":{"action":"...","version":"..."}}
 */

const fs = require('fs');

function decodePlus(s){
  return String(s || '').replace(/\+/g, ' ');
}

function parseFormUrlEncoded(body){
  const out = {};
  const parts = String(body || '').split('&');
  for (const p of parts) {
    if (!p) continue;
    const eq = p.indexOf('=');
    const k = eq >= 0 ? p.slice(0, eq) : p;
    const v = eq >= 0 ? p.slice(eq + 1) : '';
    const key = decodeURIComponent(decodePlus(k));
    const val = decodeURIComponent(decodePlus(v));
    // se repetir chave, vira array
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? prev.concat([val]) : [prev, val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

function extractDataArg(text){
  // tenta capturar --data-raw '...' | --data '...' | -d '...'
  const patterns = [
    /--data-raw\s+('([^']*)'|"([^"]*)"|([^\s\\]+))/m,
    /--data\s+('([^']*)'|"([^"]*)"|([^\s\\]+))/m,
    /-d\s+('([^']*)'|"([^"]*)"|([^\s\\]+))/m,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[2] ?? m[3] ?? m[4] ?? '';
  }
  return '';
}

function main(){
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/html5_curl_to_fields.js /path/to/curl.txt');
    process.exit(2);
  }

  const raw = fs.readFileSync(file, 'utf8');
  const data = extractDataArg(raw);
  if (!data) {
    console.error('no --data/-d found in curl');
    process.exit(3);
  }

  const fields = parseFormUrlEncoded(data);
  const hint = {
    action: fields.action || null,
    version: fields.VERSION_ID || null,
    hasVehicleId: Object.prototype.hasOwnProperty.call(fields, 'VEHICLE_ID'),
  };

  process.stdout.write(JSON.stringify({ fields, hint }, null, 2) + '\n');
}

main();
