"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitorApi = void 0;
// src/clients/monitorClient.ts
const axios_1 = __importDefault(require("axios"));
const tokenCache_1 = require("../services/tokenCache");
const baseURL = process.env.MONITOR_BASE_URL || "";
if (!baseURL) {
    console.warn("[monitorClient] MONITOR_BASE_URL não configurado. Configure nas variáveis de ambiente.");
}
exports.monitorApi = axios_1.default.create({
    baseURL,
    timeout: 15000
});
// Interceptor para injetar o token em TODAS as chamadas ao Monitor
exports.monitorApi.interceptors.request.use(async (config) => {
    const tokenInfo = await (0, tokenCache_1.getTraffiToken)();
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${tokenInfo.accessToken}`;
    return config;
}, (error) => Promise.reject(error));
