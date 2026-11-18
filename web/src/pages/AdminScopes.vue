<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import { createScope, deleteScope, listScopes, updateScope, type ScopeRow } from '../api';

/** scope 管理：新增/描述编辑/启停/删除（非空 scope 删除被后端 409 拒绝） */
const rows = ref<ScopeRow[]>([]);
const loading = ref(false);
const createOpen = ref(false);
const newScope = ref('');
const newDesc = ref('');
const editing = ref<ScopeRow | null>(null);
const editDesc = ref('');

async function fetch(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listScopes();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function onCreate(): Promise<void> {
  if (!newScope.value.trim()) { message.warning('scope 名称不能为空'); return; }
  try {
    await createScope(newScope.value.trim(), newDesc.value.trim() || undefined);
    message.success('已创建');
    createOpen.value = false;
    newScope.value = '';
    newDesc.value = '';
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

async function onToggle(row: ScopeRow, enabled: boolean): Promise<void> {
  try {
    await updateScope(row.scope, { enabled });
    row.enabled = enabled;
    message.success(enabled ? '已启用' : '已禁用');
  } catch (e) {
    message.error((e as Error).message);
    fetch();
  }
}

async function onSaveDesc(): Promise<void> {
  if (editing.value === null) return;
  try {
    await updateScope(editing.value.scope, { description: editDesc.value.trim() || undefined });
    message.success('描述已更新');
    editing.value = null;
    fetch();
  } catch (e) {
    message.error((e as Error).message);
  }
}

async function onDelete(scope: string): Promise<void> {
  try {
    await deleteScope(scope);
    message.success('已删除');
    fetch();
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'SCOPE_HAS_ENTRIES') message.warning('该 scope 下仍有条目，不能删除');
    else message.error(err.message);
  }
}

const columns = [
  { title: 'Scope', dataIndex: 'scope' },
  { title: '描述', dataIndex: 'description' },
  { title: '条目数', dataIndex: 'entryCount', width: 100 },
  { title: '创建者', dataIndex: 'createdBy', width: 120 },
  { title: '启用', dataIndex: 'enabled', width: 90 },
  { title: '操作', key: 'actions', width: 160 },
];

onMounted(fetch);
</script>

<template>
  <a-card :bordered="false" title="Scope 管理">
    <template #extra>
      <a-button type="primary" @click="createOpen = true">新增 Scope</a-button>
    </template>

    <a-table :columns="columns" :data-source="rows" :loading="loading" row-key="scope" :pagination="false">
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'enabled'">
          <a-switch :checked="record.enabled" @change="(v: boolean) => onToggle(record, v)" />
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button size="small" @click="editing = record; editDesc = record.description ?? ''">编辑描述</a-button>
            <a-popconfirm
              title="确定删除该 scope？"
              @confirm="onDelete(record.scope)"
            >
              <a-button size="small" danger>删除</a-button>
            </a-popconfirm>
          </a-space>
        </template>
      </template>
    </a-table>

    <a-modal v-model:open="createOpen" title="新增 Scope" ok-text="创建" cancel-text="取消" @ok="onCreate">
      <a-form layout="vertical">
        <a-form-item label="scope 名称">
          <a-input v-model:value="newScope" placeholder="小写-短横线，如 demo-app" />
        </a-form-item>
        <a-form-item label="描述（可选）">
          <a-textarea v-model:value="newDesc" :rows="2" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal :open="editing !== null" title="编辑描述" ok-text="保存" cancel-text="取消" @ok="onSaveDesc" @cancel="editing = null">
      <p><a-typography-text code>{{ editing?.scope }}</a-typography-text></p>
      <a-textarea v-model:value="editDesc" :rows="3" />
    </a-modal>
  </a-card>
</template>
