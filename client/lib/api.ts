import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { getApiBaseUrl } from "./urls";

// ── Storage Keys ─────────────────────────────────────────────────────────────

export const TOKEN_STORAGE_KEY = "gem_token";
export const USER_STORAGE_KEY = "gem_user";

const API_BASE_URL = getApiBaseUrl();

// ── Axios Instance ───────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10_000,
  headers: { "Content-Type": "application/json" },
});

function attachAuthHeader(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  if (typeof window === "undefined") return config;

  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}

/** Clears persisted credentials and redirects to login unless already there. */
export function clearAuthSession(redirect = true): void {
  if (typeof window === "undefined") return;

  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);

  if (redirect && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

api.interceptors.request.use(
  (config) => attachAuthHeader(config),
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: string; message?: string }>) => {
    if (error.response?.status === 401) {
      clearAuthSession(true);
    }
    return Promise.reject(error);
  }
);

// ── Types ────────────────────────────────────────────────────────────────────

export type Role = "VIEWER" | "STREAMER" | "ADMIN";

export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  username: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface TipAlertPayload {
  tipId: string;
  streamerId: string;
  viewerUsername: string;
  gemAmount: number;
  customMessage: string | null;
}

export interface UserBalanceSnapshot {
  userId: string;
  username: string;
  role: "VIEWER" | "STREAMER";
  gemBalance: number | null;
  pendingBalance: number | null;
  availableBalance: number | null;
  isPayoutEligible: boolean | null;
}

export interface TipEvent {
  id: string;
  viewerId: string;
  streamerId: string;
  gemAmount: number;
  customMessage: string | null;
  status: "PENDING" | "CLEARED" | "REVERSED";
  clearedAt: string;
  createdAt: string;
  viewer?: { username: string };
}

export interface AlertHealthResponse {
  status: string;
  service: string;
  message: string;
}

export interface DispatchResponse {
  dispatched: boolean;
  streamerId: string;
}

// ── Auth Endpoints ───────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>("/auth/login", { email, password });
  localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
  return data;
}

export async function fetchCurrentUser(): Promise<AuthUser> {
  const { data } = await api.get<AuthUser>("/auth/me");
  return data;
}

export function logout(): void {
  clearAuthSession(true);
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

// ── Alert Endpoints ──────────────────────────────────────────────────────────

export async function getAlertHealth(): Promise<AlertHealthResponse> {
  const { data } = await api.get<AlertHealthResponse>("/alerts/health");
  return data;
}

export async function dispatchTestAlert(payload: TipAlertPayload): Promise<DispatchResponse> {
  const { data } = await api.post<DispatchResponse>("/alerts/dispatch", payload);
  return data;
}

// ── Ledger Endpoints ─────────────────────────────────────────────────────────

export async function getBalance(userId: string): Promise<UserBalanceSnapshot> {
  const { data } = await api.get<UserBalanceSnapshot>(`/ledger/balance/${userId}`);
  return data;
}

// ── Crypto Endpoints ─────────────────────────────────────────────────────────

export async function requestPayout(body: {
  streamerId: string;
  gemAmount: number;
  destinationWallet: string;
}) {
  const { data } = await api.post("/crypto/payout", body);
  return data;
}

export default api;
