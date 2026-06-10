import https from "https";

const TRAFFILOG_API_BASE_URL = (
  process.env.TRAFFILOG_API_BASE_URL ||
  "https://api-il.traffilog.com/appengine_3/5E1DCD81-5138-4A35-B271-E33D71FFFFD9/1/json"
).trim();

const TOKEN_TTL_MS = 25 * 60 * 1000; // 25 minutos
let _cachedToken = "";
let _cacheTs     = 0;

export function invalidateTrafflogToken(): void {
  _cachedToken = "";
  _cacheTs     = 0;
}

export async function getTrafflogToken(): Promise<string> {
  if (_cachedToken && Date.now() - _cacheTs < TOKEN_TTL_MS) return _cachedToken;
  const loginName = (process.env.WS_LOGIN_NAME || "").trim();
  const password  = (process.env.WS_PASSWORD   || "").trim();
  if (!loginName || !password)
    throw new Error("[traffilogAuth] faltam envs: WS_LOGIN_NAME / WS_PASSWORD");

  const body = JSON.stringify({
    action: { name: "user_login", parameters: { login_name: loginName, password } }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(TRAFFILOG_API_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`[traffilogAuth] HTTP ${res.statusCode} body="${d.slice(0,200)}"`));
        }
        try {
          const props = JSON.parse(d)?.response?.properties;
          const tok = props?.session_token || props?.data?.[0]?.session_token;
          if (!tok || String(tok).trim().length < 20)
            return reject(new Error(`[traffilogAuth] login HTTP sem token av=${props?.action_value}`));
          _cachedToken = String(tok).trim();
          _cacheTs     = Date.now();
          resolve(_cachedToken);
        } catch (e) {
          reject(new Error(`[traffilogAuth] parse error: ${e}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("[traffilogAuth] HTTP timeout 10s")); });
    req.write(body);
    req.end();
  });
}
