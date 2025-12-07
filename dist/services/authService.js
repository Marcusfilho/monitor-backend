"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchNewTraffiToken = fetchNewTraffiToken;
// src/services/authService.ts
const axios_1 = __importDefault(require("axios"));
/**
 * Busca um novo token diretamente na API externa.
 * Aqui você depois vai ajustar URL, body e leitura do retorno
 * conforme sua coleção de APIs.
 */
async function fetchNewTraffiToken() {
    const url = process.env.TRAFFI_TOKEN_URL;
    const username = process.env.TRAFFI_USERNAME;
    const password = process.env.TRAFFI_PASSWORD;
    if (!url || !username || !password) {
        throw new Error("Variáveis de ambiente de auth não configuradas.");
    }
    // 👇 Aqui tipamos a resposta como AuthApiResponse
    const response = await axios_1.default.post(url, {
        username,
        password
    });
    const data = response.data;
    // TODO: ajustar esses campos conforme o JSON real da sua API
    const accessToken = data.access_token || data.token || data.AccessToken || data.jwt;
    const expiresInSeconds = data.expires_in || data.expiresIn || 3600;
    if (!accessToken) {
        console.error("Retorno da API de token:", JSON.stringify(data));
        throw new Error("API de token não retornou accessToken reconhecido.");
    }
    return {
        accessToken,
        expiresInSeconds,
        raw: data
    };
}
