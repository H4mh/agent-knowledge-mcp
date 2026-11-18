<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { SearchOutlined } from '@ant-design/icons-vue';
import { searchOrList, type KnowledgeRow, type ListItem, type Facets } from '../api';
import SearchFilters, { type Filters } from '../components/SearchFilters.vue';
import KnowledgeDetailDrawer from '../components/KnowledgeDetailDrawer.vue';
import KnowledgeForm from '../components/KnowledgeForm.vue';
import RelativeTime from '../components/RelativeTime.vue';

const activeTab = ref<'search' | 'browse'>('search');
const keyword = ref('');
const filters = ref<Filters>({});
const facets = ref<Facets>({ domains: [], scopes: [] });
const items = ref<ListItem[]>([]);
const total = ref<number | null>(null);
const loading = ref(false);
const browsePage = ref(1);
const PAGE_SIZE = 20;

const drawerId = ref<number | null>(null);
const formOpen = ref(false);
const formEditId = ref<number | undefined>(undefined);

function openNewForm(): void {
  formEditId.value = undefined;
  formOpen.value = true;
}

function onEdit(k: KnowledgeRow): void {
  drawerId.value = null;
  formEditId.value = k.id;
  formOpen.value = true;
}

function onFormSaved(): void {
  formOpen.value = false;
  fetchList();
}

const browseScope = ref<string | null>(null);
const scopeCounts = computed<{ scope: string; count: number }[]>(() => {
  const sum = facets.value.scopes.reduce((acc, s) => acc + s.count, 0);
  return [
    { scope: '全部', count: sum },
    ...facets.value.scopes.map((s) => ({ scope: s.value, count: s.count })),
  ];
});

async function fetchList(): Promise<void> {
  loading.value = true;
  try {
    if (activeTab.value === 'search') {
      const res = await searchOrList({ q: keyword.value, ...filters.value });
      items.value = res.items;
      total.value = res.total;
      facets.value = res.facets;
    } else {
      const res = await searchOrList({
        scope: browseScope.value ?? undefined,
        ...filters.value,
        page: browsePage.value,
        pageSize: PAGE_SIZE,
      });
      items.value = res.items;
      total.value = res.total;
      facets.value = res.facets;
    }
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

watch(activeTab, () => {
  browsePage.value = 1;
  fetchList();
});
watch(filters, () => {
  if (activeTab.value === 'browse') browsePage.value = 1;
  fetchList();
});
watch(browseScope, () => {
  browsePage.value = 1;
  fetchList();
});

function doSearch(): void {
  activeTab.value = 'search';
  fetchList();
}

function pickScope(info: { key: string | number }): void {
  const key = info.key;
  browseScope.value = key === '全部' ? null : String(key);
}

function statusColor(s: string): string {
  return s === 'verified' ? 'green' : s === 'deprecated' ? 'red' : 'default';
}
function statusLabel(s: string): string {
  return s === 'verified' ? '已验证' : s === 'deprecated' ? '已废弃' : '草稿';
}

onMounted(fetchList);
</script>

<template>
  <a-card :bordered="false">
    <a-tabs v-model:active-key="activeTab">
      <a-tab-pane key="search" tab="检索">
        <a-input-search
          v-model:value="keyword"
          placeholder="输入关键词检索知识条目"
          enter-button
          style="max-width: 560px; margin-bottom: 12px"
          @search="doSearch"
        />
        <SearchFilters v-model:filters="filters" :facets="facets" style="margin-bottom: 16px" />
        <a-list :data-source="items" :loading="loading" item-layout="vertical">
          <template #renderItem="{ item }">
            <a-list-item @click="drawerId = item.id">
              <a-list-item-meta>
                <template #title>
                  <a-space wrap>
                    <a-tag :color="statusColor(item.status)">{{ statusLabel(item.status) }}</a-tag>
                    <span>{{ item.title }}</span>
                  </a-space>
                </template>
                <template #description>
                  <div class="truncate">{{ item.symptom }}</div>
                </template>
              </a-list-item-meta>
              <a-space wrap size="small">
                <a-tag color="blue">{{ item.domain }}</a-tag>
                <a-tag>{{ item.scope }}</a-tag>
                <a-tag v-for="t in item.tags" :key="t">{{ t }}</a-tag>
                <span class="meta">{{ item.author }} · 用过 {{ item.use_count }} 次 · <RelativeTime :time="item.updated_at" /></span>
              </a-space>
            </a-list-item>
          </template>
        </a-list>
        <a-alert
          v-if="activeTab === 'search' && items.length >= 50"
          type="info"
          show-icon
          message="最多展示 50 条，请细化关键词"
          style="margin-top: 12px"
        />
        <a-empty v-if="!loading && items.length === 0" description="没有匹配的知识条目" style="margin-top: 24px" />
      </a-tab-pane>

      <a-tab-pane key="browse" tab="浏览">
        <a-layout style="background: #fff; min-height: 400px">
          <a-layout-sider width="220" theme="light" class="scope-sider">
            <a-menu :selected-keys="[browseScope ?? '全部']" @click="pickScope">
              <a-menu-item v-for="row in scopeCounts" :key="row.scope">
                <span>{{ row.scope }}</span>
                <span class="scope-count">{{ row.count }}</span>
              </a-menu-item>
            </a-menu>
          </a-layout-sider>
          <a-layout-content style="padding-left: 16px">
            <SearchFilters v-model:filters="filters" :facets="facets" style="margin-bottom: 12px" />
            <a-list :data-source="items" :loading="loading" item-layout="vertical">
              <template #renderItem="{ item }">
                <a-list-item @click="drawerId = item.id">
                  <a-list-item-meta>
                    <template #title>
                      <a-space wrap>
                        <a-tag :color="statusColor(item.status)">{{ statusLabel(item.status) }}</a-tag>
                        <span>{{ item.title }}</span>
                      </a-space>
                    </template>
                    <template #description>
                      <div class="truncate">{{ item.symptom }}</div>
                    </template>
                  </a-list-item-meta>
                  <a-space wrap size="small">
                    <a-tag color="blue">{{ item.domain }}</a-tag>
                    <a-tag>{{ item.scope }}</a-tag>
                    <span class="meta">{{ item.author }} · <RelativeTime :time="item.updated_at" /></span>
                  </a-space>
                </a-list-item>
              </template>
            </a-list>
            <a-pagination
              v-if="total !== null && total > PAGE_SIZE"
              v-model:current="browsePage"
              :total="total"
              :page-size="PAGE_SIZE"
              @change="fetchList"
              style="margin-top: 16px"
            />
          </a-layout-content>
        </a-layout>
      </a-tab-pane>
    </a-tabs>

    <template #extra>
      <a-button type="primary" @click="openNewForm">新增知识</a-button>
    </template>

    <KnowledgeDetailDrawer v-model:id="drawerId" @edit="onEdit" @saved="fetchList" />
    <KnowledgeForm
      :open="formOpen"
      :edit-id="formEditId"
      :scopes="facets.scopes.map((s) => s.value)"
      @close="formOpen = false"
      @saved="onFormSaved"
      @view="(id) => (drawerId = id)"
    />
  </a-card>
</template>

<style scoped>
.truncate {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  color: #999;
  font-size: 12px;
}
.scope-sider {
  border-right: 1px solid #f0f0f0;
}
.scope-count {
  float: right;
  color: #999;
  font-size: 12px;
}
</style>
