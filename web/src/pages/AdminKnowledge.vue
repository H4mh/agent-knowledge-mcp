<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { MoreOutlined } from '@ant-design/icons-vue';
import { deleteKnowledge, searchOrList, setStatus, type Facets, type ListItem } from '../api';
import SearchFilters, { type Filters } from '../components/SearchFilters.vue';
import KnowledgeDetailDrawer from '../components/KnowledgeDetailDrawer.vue';
import RelativeTime from '../components/RelativeTime.vue';

/** 知识条目管理：浏览模式表格 + 状态流转/删除（管理员） */
const PAGE_SIZE = 20;
const items = ref<ListItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const facets = ref<Facets>({ domains: [], scopes: [] });
const filters = ref<Filters>({});
const drawerId = ref<number | null>(null);

const pagination = reactive({
  total: 0,
  current: 1,
  pageSize: PAGE_SIZE,
  showTotal: (t: number) => `共 ${t} 条`,
  onChange: (p: number) => {
    page.value = p;
    fetch();
  },
});

async function fetch(): Promise<void> {
  loading.value = true;
  try {
    const res = await searchOrList({ ...filters.value, page: page.value, pageSize: PAGE_SIZE });
    items.value = res.items;
    facets.value = res.facets;
    total.value = res.total ?? res.items.length;
    pagination.total = total.value;
    pagination.current = page.value;
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function changeStatus(id: number, status: string, label: string): Promise<void> {
  try {
    await setStatus(id, status);
    message.success(label);
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

async function onDelete(id: number): Promise<void> {
  try {
    await deleteKnowledge(id);
    message.success('已删除');
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

const columns = [
  { title: '标题', dataIndex: 'title' },
  { title: '状态', dataIndex: 'status', width: 100 },
  { title: '领域', dataIndex: 'domain', width: 100 },
  { title: 'Scope', dataIndex: 'scope', width: 140 },
  { title: '作者', dataIndex: 'author', width: 120 },
  { title: '用过', dataIndex: 'use_count', width: 80 },
  { title: '更新时间', dataIndex: 'updated_at', width: 130 },
  { title: '操作', key: 'actions', width: 200 },
];

function statusLabel(s: string): string {
  return s === 'verified' ? '已验证' : s === 'deprecated' ? '已废弃' : '草稿';
}
function statusColor(s: string): string {
  return s === 'verified' ? 'green' : s === 'deprecated' ? 'red' : 'default';
}

onMounted(fetch);
</script>

<template>
  <a-card :bordered="false" title="知识条目管理">
    <SearchFilters v-model:filters="filters" :facets="facets" style="margin-bottom: 16px" />
    <a-table
      :columns="columns"
      :data-source="items"
      :loading="loading"
      :pagination="pagination"
      row-key="id"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'title'">
          <a @click="drawerId = record.id">{{ record.title }}</a>
        </template>
        <template v-else-if="column.dataIndex === 'status'">
          <a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag>
        </template>
        <template v-else-if="column.dataIndex === 'updated_at'">
          <RelativeTime :time="record.updated_at" />
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-dropdown>
            <a-button size="small">
              <MoreOutlined />
            </a-button>
            <template #overlay>
              <a-menu>
                <a-menu-item v-if="record.status !== 'verified'" @click="changeStatus(record.id, 'verified', '已设为已验证')">
                  设为 verified
                </a-menu-item>
                <a-menu-item v-if="record.status !== 'deprecated'" @click="changeStatus(record.id, 'deprecated', '已设为已废弃')">
                  设为 deprecated
                </a-menu-item>
                <a-menu-item v-if="record.status !== 'draft'" @click="changeStatus(record.id, 'draft', '已恢复为草稿')">
                  恢复 draft
                </a-menu-item>
                <a-menu-item danger>
                  <a-popconfirm
                    title="确定删除该条目？删除后不可恢复"
                    @confirm="onDelete(record.id)"
                  >
                    删除
                  </a-popconfirm>
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </template>
      </template>
    </a-table>

    <KnowledgeDetailDrawer v-model:id="drawerId" @saved="fetch" />
  </a-card>
</template>
