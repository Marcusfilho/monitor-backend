import cors from "cors";

function parseOrigins(v?: string) {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Regra:
 * - Sem Origin (curl/healthcheck/server-to-server): libera (true)
 * - Com Origin:
 *    - whitelist vazia -> REFLETE origin (cb(null, origin))
 *    - origin na whitelist -> REFLETE origin (cb(null, origin))
 *    - caso contrário -> bloqueia (false)
 */
export const corsMw = cors({
  origin(origin, cb) {
    const allowed = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

    if (!origin) return cb(null, true);

    if (allowed.length === 0) return cb(null, origin);

    if (allowed.includes(origin)) return cb(null, origin);

    return cb(null, false);
  },

  methods: "GET,POST,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization,X-Admin-Key,X-Worker-Key",
  maxAge: 86400,
  optionsSuccessStatus: 204,
});
