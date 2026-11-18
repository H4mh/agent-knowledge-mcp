import { apiFetch } from './auth';

/** REST 端点类型化调用（与 src/api/queries.ts、src/api/routes.ts 的响应结构一一对应） */

export interface CurrentUser {
  username: string;
  role: 'user' | 'admin';
}

export interface ListItem {
  id: number;
  title: string;
  symptom: string;
  solution: string;
  status: string;
  scope: string;
  domain: string;
  module: string | null;
  tags: string[];
  author: string;
  use_count: number;
  last_used_at: string | null;
  updated_at: string;
  score?: number;
}

export interface Facets {
  domains: { value: string; count: number }[];
  scopes: { value: string; count: number }[];
}

export interface KnowledgeRow extends ListItem {
  detail: string | null;
  code_ref: string | null;
  created_at: string;
}

export interface ListResult {
  mode: 'search' | 'browse';
  items: ListItem[];
  total: number | null;
  facets: Facets;
}

export interface SaveInput {
  title: string;
  symptom: string;
  solution: string;
  detail?: string;
  domain: string;
  scope: string;
  module?: string;
  tags: string[];
  code_ref?: string;
}

export interface SaveResult {
  id: number;
  status: 'draft';
  similar: { id: number; title: string; similarity: number }[];
  warnings: string[];
  scopeRegistered: boolean;
}

export interface PreviewResult {
  similar: SaveResult['similar'];
  warnings: string[];
  scopeWillRegister: boolean;
}

export interface ScopeRow {
  scope: string;
  description: string | null;
  enabled: boolean;
  createdBy: string | null;
  entryCount: number;
}

export interface UserRow {
  username: string;
  role: string;
  enabled: boolean;
  createdAt: string;
}

export interface Stats {
  byStatus: Record<string, number>;
  byDomain: Record<string, number>;
  byScope: { value: string; count: number }[];
  topUsed: { id: number; title: string; use_count: number }[];
  recentMisses: { query: string; count: number }[];
  userCount: number;
}

export function me(): Promise<CurrentUser> {
  return apiFetch<CurrentUser>('/api/me');
}

export function searchOrList(params: {
  q?: string; domain?: string; scope?: string; status?: string; tag?: string; page?: number; pageSize?: number;
}): Promise<ListResult> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return apiFetch<ListResult>(`/api/knowledge${qs ? `?${qs}` : ''}`);
}

export function getKnowledge(id: number): Promise<KnowledgeRow> {
  return apiFetch<KnowledgeRow>(`/api/knowledge/${id}`);
}

export function preview(input: SaveInput): Promise<PreviewResult> {
  return apiFetch<PreviewResult>('/api/knowledge/preview', { method: 'POST', body: JSON.stringify(input) });
}

export function saveKnowledge(input: SaveInput): Promise<SaveResult> {
  return apiFetch<SaveResult>('/api/knowledge', { method: 'POST', body: JSON.stringify(input) });
}

export function updateKnowledge(id: number, patch: Partial<SaveInput>): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
}

export function markUsed(id: number, note?: string): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/api/knowledge/${id}/used`, { method: 'POST', body: JSON.stringify({ note }) });
}

export function setStatus(id: number, status: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/knowledge/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
}

export function deleteKnowledge(id: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' });
}

export function listScopes(): Promise<ScopeRow[]> {
  return apiFetch<ScopeRow[]>('/api/scopes');
}

export function createScope(scope: string, description?: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/scopes', { method: 'POST', body: JSON.stringify({ scope, description }) });
}

export function updateScope(scope: string, patch: { description?: string; enabled?: boolean }): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/scopes/${encodeURIComponent(scope)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteScope(scope: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/scopes/${encodeURIComponent(scope)}`, { method: 'DELETE' });
}

export function listUsers(): Promise<UserRow[]> {
  return apiFetch<UserRow[]>('/api/users');
}

export function setUserEnabled(username: string, enabled: boolean): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/users/${encodeURIComponent(username)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
}

export interface SkillFile {
  path: string;
  content: string;
}

/** 列表/检索返回的 skill 条目（GET /api/skills，检索模式多 score） */
export interface SkillItem {
  id: number;
  name: string;
  description: string;
  status: string;
  scope: string | null;
  tags: string[];
  author: string;
  version: number;
  use_count: number;
  updated_at: string;
  score?: number;
}

/** 详情返回（GET /api/skills/:name，含 instructions 与 files JSONB 原样） */
export interface SkillDetail extends SkillItem {
  instructions: string;
  files: SkillFile[];
  last_used_at: string | null;
  created_at: string;
}

export interface SkillFacets {
  scopes: { value: string | null; count: number }[];
}

export interface SkillListResult {
  mode: 'search' | 'browse';
  items: SkillItem[];
  total: number | null;
  facets: SkillFacets;
}

export interface SaveSkillInput {
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[];
  scope?: string;
  tags?: string[];
}

export function listOrSearchSkills(params: {
  q?: string; scope?: string; page?: number; pageSize?: number;
}): Promise<SkillListResult> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return apiFetch<SkillListResult>(`/api/skills${qs ? `?${qs}` : ''}`);
}

export function getSkill(name: string): Promise<SkillDetail> {
  return apiFetch<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);
}

export function saveSkill(input: SaveSkillInput): Promise<{ id: number; status: string }> {
  return apiFetch<{ id: number; status: string }>('/api/skills', { method: 'POST', body: JSON.stringify(input) });
}

/** PUT /api/skills/:name 补丁：scope 允许 null（显式清空）；undefined 保留原值（files/tags 同理，编辑模式清空须发 []） */
export type UpdateSkillPatch = Omit<SaveSkillInput, 'name' | 'scope'> & { scope?: string | null };

export function updateSkill(name: string, patch: UpdateSkillPatch): Promise<{ ok: true; version: number }> {
  return apiFetch<{ ok: true; version: number }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(patch) });
}

export function deleteSkill(name: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** 修订历史条目（GET /api/knowledge/:id/revisions、GET /api/skills/:name/revisions；changes 为 {字段: 旧值} 映射） */
export interface Revision {
  version: number;
  kind: 'content' | 'status';
  changedBy: string;
  changes: Record<string, unknown>;
  createdAt: string;
}

/** 修订历史只读端点：knowledge 按 id、skill 按 name 定位，最多返回最近 50 条 */
export function fetchRevisions(kind: 'knowledge' | 'skill', idOrName: number | string): Promise<Revision[]> {
  const path =
    kind === 'knowledge'
      ? `/api/knowledge/${idOrName}/revisions`
      : `/api/skills/${encodeURIComponent(String(idOrName))}/revisions`;
  return apiFetch<{ revisions: Revision[] }>(path).then((r) => r.revisions);
}

export function getStats(): Promise<Stats> {
  return apiFetch<Stats>('/api/stats');
}
