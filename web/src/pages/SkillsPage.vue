<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import { PlusOutlined } from '@ant-design/icons-vue';
import { listOrSearchSkills, type SkillItem, type SkillFacets } from '../api';
import { currentUser } from '../auth';
import SkillDetailDrawer from '../components/SkillDetailDrawer.vue';
import SkillForm from '../components/SkillForm.vue';
import RelativeTime from '../components/RelativeTime.vue';

const router = useRouter();
const route = useRoute();

/**
 * Skills 门户页：检索（q 混合检索 top 50）/ 浏览（scope facets + 分页列表）双页签，结构照 SearchPage.vue。
 */
const activeTab = ref<'search' | 'browse'>('search');
const keyword = ref('');
const facets = ref<SkillFacets>({ scopes: [] });
const items = ref<SkillItem[]>([]);
const total = ref<number | null>(null);
const loading = ref(false);
const browsePage = ref(1);
const PAGE_SIZE = 20;

const drawerName = ref<string | null>(null);
const formOpen = ref(false);
const formEditName = ref<string | undefined>(undefined);

/** 未登录点上传/编辑入口先跳独立登录页（携带当前路径回跳），模式与 App.vue goLogin 一致 */
function requireLogin(): boolean {
  if (!currentUser.value) {
    router.push({ name: 'login', query: { redirect: route.fullPath } });
    return false;
  }
  return true;
}

function openNewForm(): void {
  if (!requireLogin()) return;
  formEditName.value = undefined;
  formOpen.value = true;
}

function onEdit(s: { name: string }): void {
  if (!requireLogin()) return;
  drawerName.value = null;
  formEditName.value = s.name;
  formOpen.value = true;
}

function onFormSaved(): void {
  formOpen.value = false;
  fetchList();
}

const browseScope = ref<string | null>(null);
const scopeCounts = computed<{ scope: string; count: number }[]>(() => {
  return facets.value.scopes.map((s) => ({ scope: s.value ?? '（未指定）', count: s.count }));
});
const scopeOptions = computed(() =>
  scopeCounts.value
    .filter((s) => s.scope !== '（未指定）')
    .map((s) => ({ value: s.scope, label: `${s.scope} (${s.count})` })),
);

async function fetchList(): Promise<void> {
  loading.value = true;
  try {
    if (activeTab.value === 'search') {
      const res = await listOrSearchSkills({ q: keyword.value });
      items.value = res.items;
      total.value = res.total;
      facets.value = res.facets;
    } else {
      const res = await listOrSearchSkills({
        scope: browseScope.value ?? undefined,
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
watch(browseScope, () => {
  browsePage.value = 1;
  fetchList();
});

function doSearch(): void {
  if (!keyword.value.trim()) { message.warning('请输入关键词'); return; }
  activeTab.value = 'search';
  fetchList();
}

function pickScope(info: { key: string | number }): void {
  const key = String(info.key);
  browseScope.value = key === '全部' ? null : key;
}

function statusColor(s: string): string {
  return s === 'verified' ? 'green' : s === 'deprecated' ? 'orange' : 'default';
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
          placeholder="输入关键词检索 Skills"
          enter-button
          style="max-width: 560px; margin-bottom: 12px"
          @search="doSearch"
        />
        <a-list :data-source="items" :loading="loading" item-layout="vertical">
          <template #renderItem="{ item }">
            <a-list-item @click="drawerName = item.name">
              <a-list-item-meta>
                <template #title>
                  <a-space wrap>
                    <a-tag :color="statusColor(item.status)">{{ statusLabel(item.status) }}</a-tag>
                    <span>{{ item.name }}</span>
                    <a-tag>v{{ item.version }}</a-tag>
                  </a-space>
                </template>
                <template #description>
                  <div class="truncate">{{ item.description }}</div>
                </template>
              </a-list-item-meta>
              <a-space wrap size="small">
                <a-tag v-if="item.scope">{{ item.scope }}</a-tag>
                <a-tag v-for="t in item.tags" :key="t">{{ t }}</a-tag>
                <span class="meta">
                  {{ item.author }} · 用过 {{ item.use_count }} 次 · <RelativeTime :time="item.updated_at" />
                  <template v-if="item.score !== undefined"> · 相关度 {{ (item.score * 100).toFixed(0) }}%</template>
                </span>
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
        <a-empty v-if="!loading && items.length === 0" description="没有匹配的 Skill" style="margin-top: 24px" />
      </a-tab-pane>

      <a-tab-pane key="browse" tab="浏览">
        <a-layout style="background: #fff; min-height: 400px">
          <a-layout-sider width="220" theme="light" class="scope-sider">
            <a-menu :selected-keys="[browseScope ?? '全部']" @click="pickScope">
              <a-menu-item key="全部">
                <span>全部</span>
                <span class="scope-count">{{ facets.scopes.reduce((acc, s) => acc + s.count, 0) }}</span>
              </a-menu-item>
              <a-menu-item v-for="row in scopeCounts" :key="row.scope" :disabled="row.scope === '（未指定）'">
                <span>{{ row.scope }}</span>
                <span class="scope-count">{{ row.count }}</span>
              </a-menu-item>
            </a-menu>
          </a-layout-sider>
          <a-layout-content style="padding-left: 16px">
            <a-select
              :value="browseScope ?? '全部'"
              :options="scopeOptions"
              style="width: 240px; margin-bottom: 12px"
              @change="(v: unknown) => { browseScope = v === '全部' ? null : String(v); }"
            />            <a-list :data-source="items" :loading="loading" item-layout="vertical">
              <template #renderItem="{ item }">
                <a-list-item @click="drawerName = item.name">
                  <a-list-item-meta>
                    <template #title>
                      <a-space wrap>
                        <a-tag :color="statusColor(item.status)">{{ statusLabel(item.status) }}</a-tag>
                        <span>{{ item.name }}</span>
                        <a-tag>v{{ item.version }}</a-tag>
                      </a-space>
                    </template>
                    <template #description>
                      <div class="truncate">{{ item.description }}</div>
                    </template>
                  </a-list-item-meta>
                  <a-space wrap size="small">
                    <a-tag v-if="item.scope">{{ item.scope }}</a-tag>
                    <a-tag v-for="t in item.tags" :key="t">{{ t }}</a-tag>
                    <span class="meta">{{ item.author }} · 用过 {{ item.use_count }} 次 · <RelativeTime :time="item.updated_at" /></span>
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
            <a-empty v-if="!loading && items.length === 0" description="该 scope 下暂无 Skill" style="margin-top: 24px" />
          </a-layout-content>
        </a-layout>
      </a-tab-pane>
    </a-tabs>

    <template #extra>
      <a-button type="primary" @click="openNewForm">
        <template #icon><PlusOutlined /></template>
        新增 Skill
      </a-button>
    </template>

    <SkillDetailDrawer v-model:name="drawerName" @edit="onEdit" @saved="fetchList" />
    <SkillForm
      :open="formOpen"
      :edit-name="formEditName"
      :scopes="scopeCounts.filter((s) => s.scope !== '（未指定）').map((s) => s.scope)"
      @close="formOpen = false"
      @saved="onFormSaved"
      @view="(name) => (drawerName = name)"
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
