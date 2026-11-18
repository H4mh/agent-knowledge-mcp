import { computed, ref } from 'vue';

/**
 * 门户鉴权：token 存 localStorage，请求统一经 apiFetch 携带 Bearer；
 * 401 统一登出（token 失效/被禁用后自动跳转 /login 并携带回跳地址）。
 */
const TOKEN_KEY = 'akm_token';

export interface CurrentUser {
  username: string;
  role: 'user' | 'admin';
}

export const currentUser = ref<CurrentUser | null>(null);
export const loggedIn = computed(() => currentUser.value !== null);
export const isAdmin = computed(() => currentUser.value?.role === 'admin');

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export class UnauthorizedError extends Error {
  constructor() {
    super('身份不存在：请先通过 agent 端 MCP 使用一次（首次使用自动注册），或联系管理员创建身份');
  }
}

/** 401 统一处理：登出并跳转独立登录页（带回跳地址），避免停留报错 */
function logoutAndRedirect(): void {
  logout();
  const current = window.location.pathname + window.location.search;
  window.location.assign(`/login?redirect=${encodeURIComponent(current)}`);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    logoutAndRedirect();
    throw new UnauthorizedError();
  }
  if (res.status === 429) throw new Error('请求过于频繁，请稍后再试');
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.message ?? '请求失败'), { code: body.error, status: res.status });
  return body as T;
}

/** 用给定 token 探测身份（GET /api/me 仅校验不注册）；成功写 localStorage */
export async function login(token: string): Promise<CurrentUser> {
  const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 429) throw new Error('请求过于频繁，请稍后再试');
    throw new Error('登录失败，请稍后再试');
  }
  storeToken(token);
  const user = (await res.json()) as CurrentUser;
  currentUser.value = user;
  return user;
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  currentUser.value = null;
}

/** 页面加载时用已存 token 恢复会话；失效则由 apiFetch 的 401 分支登出并跳转登录页 */
export async function loadMe(): Promise<void> {
  if (!getToken()) return;
  try {
    currentUser.value = await apiFetch<CurrentUser>('/api/me');
  } catch {
    /* token 无效：apiFetch 401 分支已登出并 window.location.assign('/login?redirect=...') */
  }
}
