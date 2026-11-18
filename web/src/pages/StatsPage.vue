<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import { getStats, type Stats } from '../api';

/** 统计页：数字卡 + 域/scope 分布横条 + 高频使用/近期未命中两个表 */
const stats = ref<Stats | null>(null);
const loading = ref(false);

async function fetch(): Promise<void> {
  loading.value = true;
  try {
    stats.value = await getStats();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

const totalCount = computed(() =>
  stats.value ? Object.values(stats.value.byStatus).reduce((a, b) => a + b, 0) : 0,
);

function toProgressRows(record: Record<string, number> | undefined): { label: string; count: number; percent: number }[] {
  if (!stats.value) return [];
  const entries = Object.entries(record ?? {});
  const max = Math.max(...entries.map(([, c]) => c), 1);
  return entries.map(([label, count]) => ({ label, count, percent: Math.round((count / max) * 100) }));
}

const domainRows = computed(() => toProgressRows(stats.value?.byDomain));
const scopeRows = computed(() => toProgressRows(stats.value?.byScope.map((s) => [s.value, s.count] as [string, number]).reduce<Record<string, number>>((acc, [v, c]) => { acc[v] = c; return acc; }, {})));

const topUsedColumns = [
  { title: '标题', dataIndex: 'title' },
  { title: '使用次数', dataIndex: 'use_count', width: 120 },
];
const missColumns = [
  { title: '检索词', dataIndex: 'query' },
  { title: '次数', dataIndex: 'count', width: 100 },
];

onMounted(fetch);
</script>

<template>
  <a-card :bordered="false" title="知识统计">
    <a-spin :spinning="loading">
      <a-row :gutter="16" style="margin-bottom: 24px">
        <a-col :span="6">
          <a-card size="small"><a-statistic title="知识总条数" :value="totalCount" /></a-card>
        </a-col>
        <a-col :span="6">
          <a-card size="small"><a-statistic title="已验证" :value="stats?.byStatus?.verified ?? 0" :value-style="{ color: '#3f8600' }" /></a-card>
        </a-col>
        <a-col :span="6">
          <a-card size="small"><a-statistic title="草稿" :value="stats?.byStatus?.draft ?? 0" /></a-card>
        </a-col>
        <a-col :span="6">
          <a-card size="small"><a-statistic title="注册用户" :value="stats?.userCount ?? 0" /></a-card>
        </a-col>
      </a-row>

      <a-row :gutter="16" style="margin-bottom: 24px">
        <a-col :span="12">
          <a-card size="small" title="领域分布">
            <div v-for="r in domainRows" :key="r.label" style="margin-bottom: 4px">
              <div class="bar-label">{{ r.label }}（{{ r.count }}）</div>
              <a-progress :percent="r.percent" :show-info="false" size="small" />
            </div>
            <a-empty v-if="domainRows.length === 0" :image-style="{ height: '40px' }" description="暂无数据" />
          </a-card>
        </a-col>
        <a-col :span="12">
          <a-card size="small" title="Scope 分布">
            <div v-for="r in scopeRows" :key="r.label" style="margin-bottom: 4px">
              <div class="bar-label">{{ r.label }}（{{ r.count }}）</div>
              <a-progress :percent="r.percent" :show-info="false" size="small" />
            </div>
            <a-empty v-if="scopeRows.length === 0" :image-style="{ height: '40px' }" description="暂无数据" />
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-card size="small" title="使用最多的条目">
            <a-table :columns="topUsedColumns" :data-source="stats?.topUsed ?? []" row-key="id" :pagination="false" size="small" />
          </a-card>
        </a-col>
        <a-col :span="12">
          <a-card size="small" title="近 30 天未命中检索词">
            <a-table :columns="missColumns" :data-source="stats?.recentMisses ?? []" row-key="query" :pagination="false" size="small" />
          </a-card>
        </a-col>
      </a-row>
    </a-spin>
  </a-card>
</template>

<style scoped>
.bar-label {
  font-size: 12px;
  color: #666;
}
</style>
