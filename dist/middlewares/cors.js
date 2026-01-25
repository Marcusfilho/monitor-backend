"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsMw = void 0;
const cors_1 = __importDefault(require("cors"));
function parseOrigins(v) {
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
exports.corsMw = (0, cors_1.default)({
    origin(origin, cb) {
        const allowed = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);
        if (!origin)
            return cb(null, true);
        if (allowed.length === 0)
            return cb(null, origin);
        if (allowed.includes(origin))
            return cb(null, origin);
        return cb(null, false);
    },
    methods: "GET,POST,PUT,DELETE,OPTIONS",
    allowedHeaders: "Content-Type,Authorization,X-Admin-Key,X-Worker-Key",
    maxAge: 86400,
    optionsSuccessStatus: 204,
});
