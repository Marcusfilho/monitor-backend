import https from "https";

const TRAFFILOG_API_BASE_URL = (
  process.env.TRAFFILOG_API_BASE_URL ||
  "https://api-il.traffilog.com/appengine_3/5E1DCD81-5138-4A35-B271-E33D71FFFFD9/1/json"
).trim();

export async function getTrafflogToken(): Promise<string> {
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
          resolve(String(tok).trim());
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
