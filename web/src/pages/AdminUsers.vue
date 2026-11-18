<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import { listUsers, setUserEnabled, type UserRow } from '../api';

/** 用户管理：禁用（token 永久封禁）/启用 */
const rows = ref<UserRow[]>([]);
const loading = ref(false);

async function fetch(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listUsers();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function onDisable(row: UserRow): Promise<void> {
  try {
    await setUserEnabled(row.username, false);
    message.success(`已禁用 ${row.username}，该 token 将永久封禁`);
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

async function onEnable(row: UserRow): Promise<void> {
  try {
    await setUserEnabled(row.username, true);
    message.success(`已启用 ${row.username}`);
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

const columns = [
  { title: '用户名', dataIndex: 'username' },
  { title: '角色', dataIndex: 'role', width: 100 },
  { title: '状态', dataIndex: 'enabled', width: 100 },
  { title: '注册时间', dataIndex: 'createdAt', width: 180 },
  { title: '操作', key: 'actions', width: 140 },
];

function fmtTime(t: string): string {
  return new Date(t).toLocaleString('zh-CN');
}

onMounted(fetch);
</script>

<template>
  <a-card :bordered="false" title="用户管理">
    <a-table :columns="columns" :data-source="rows" :loading="loading" row-key="username" :pagination="false">
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'role'">
          <a-tag :color="record.role === 'admin' ? 'purple' : 'default'">{{ record.role === 'admin' ? '管理员' : '用户' }}</a-tag>
        </template>
        <template v-else-if="column.dataIndex === 'enabled'">
          <a-badge :status="record.enabled ? 'success' : 'error'" :text="record.enabled ? '正常' : '已禁用'" />
        </template>
        <template v-else-if="column.dataIndex === 'createdAt'">
          {{ fmtTime(record.createdAt) }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-popconfirm
            v-if="record.enabled"
            :title="`禁用后该 token 将永久封禁，确定禁用 ${record.username}？`"
            @confirm="onDisable(record)"
          >
            <a-button size="small" danger>禁用</a-button>
          </a-popconfirm>
          <a-button v-else size="small" @click="onEnable(record)">启用</a-button>
        </template>
      </template>
    </a-table>
  </a-card>
</template>
