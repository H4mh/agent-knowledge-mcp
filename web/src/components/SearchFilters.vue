<script setup lang="ts">
import type { Facets } from '../api';

/**
 * 过滤器组：domain/scope/status/tag 四个下拉，选项来自响应 facets；
 * v-model 式——props.filters 双向绑定（update:filters）。
 */
export interface Filters {
  domain?: string;
  scope?: string;
  status?: string;
  tag?: string;
}

const props = defineProps<{ filters: Filters; facets: Facets }>();
const emit = defineEmits<{ 'update:filters': [f: Filters] }>();

function set(key: keyof Filters, value: unknown): void {
  emit('update:filters', { ...props.filters, [key]: value || undefined });
}

const statusOptions = [
  { value: 'draft', label: '草稿' },
  { value: 'verified', label: '已验证' },
  { value: 'deprecated', label: '已废弃' },
];

function toOptions(list: { value: string; count: number }[]) {
  return list.map((o) => ({ value: o.value, label: `${o.value}（${o.count}）` }));
}
</script>

<template>
  <a-space wrap>
    <a-select
      :value="filters.domain"
      allow-clear
      placeholder="领域"
      style="width: 150px"
      :options="toOptions(facets.domains)"
      @change="(v: unknown) => set('domain', v)"
    />
    <a-select
      :value="filters.scope"
      allow-clear
      placeholder="Scope"
      style="width: 180px"
      :options="toOptions(facets.scopes)"
      @change="(v: unknown) => set('scope', v)"
    />
    <a-select
      :value="filters.status"
      allow-clear
      placeholder="状态"
      style="width: 130px"
      :options="statusOptions"
      @change="(v: unknown) => set('status', v)"
    />
    <a-input
      :value="filters.tag"
      allow-clear
      placeholder="按标签过滤"
      style="width: 150px"
      @change="(e: InputEvent) => set('tag', (e.target as HTMLInputElement).value)"
    />
  </a-space>
</template>
