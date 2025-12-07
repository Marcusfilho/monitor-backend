// src/clients/monitorClient.ts
import axios from "axios";
import { getTraffiToken } from "../services/tokenCache";

const baseURL = process.env.MONITOR_BASE_URL || "";

if (!baseURL) {
  console.warn(
    "[monitorClient] MONITOR_BASE_URL não configurado. Configure nas variáveis de ambiente."
  );
}

export const monitorApi = axios.create({
  baseURL,
  timeout: 15000
});

// Interceptor para injetar o token em TODAS as chamadas ao Monitor
(monitorApi.interceptors.request as any).use(
  async (config: any) => {
    const tokenInfo = await getTraffiToken();

    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${tokenInfo.accessToken}`;

    return config;
  },
  (error: any) => Promise.reject(error)
);
