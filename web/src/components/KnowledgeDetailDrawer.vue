<script setup lang="ts">
import { ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { CheckCircleFilled, EditOutlined } from '@ant-design/icons-vue';
import { fetchRevisions, getKnowledge, markUsed, type KnowledgeRow, type Revision } from '../api';
import { currentUser } from '../auth';
import RelativeTime from './RelativeTime.vue';

/**
 * 知识详情抽屉：props.id 为 null 表示关闭；
 * mark_used 成功后 emit saved（父级刷新 use_count）；
 * 编辑按钮仅 author 或 admin 可见（emit edit 交给 Task 11 表单）。
 */
const props = defineProps<{ id: number | null }>();
const emit = defineEmits<{ 'update:id': [id: number | null]; edit: [k: KnowledgeRow]; saved: [] }>();

const detail = ref<KnowledgeRow | null>(null);
const loading = ref(false);
const used = ref(false);

// 修订历史：打开抽屉时懒加载，失败静默降级（面板空态，不阻塞详情）
const revisions = ref<Revision[] | null>(null);
const revisionsLoading = ref(false);
let revisionSeq = 0;

watch(
  () => props.id,
  async (id) => {
    revisions.value = null;
    const seq = ++revisionSeq;
    if (id === null) return;
    revisionsLoading.value = true;
    try {
      const rows = await fetchRevisions('knowledge', id);
      if (seq === revisionSeq) revisions.value = rows;
    } catch {
      /* 静默降级：修订历史获取失败不提示、不影响详情展示 */
    } finally {
      if (seq === revisionSeq) revisionsLoading.value = false;
    }
  },
);

watch(
  () => props.id,
  async (id) => {
    detail.value = null;
    used.value = false;
    if (id === null) return;
    loading.value = true;
    try {
      detail.value = await getKnowledge(id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      loading.value = false;
    }
  },
);

async function onMarkUsed(): Promise<void> {
  if (detail.value === null || used.value) return;
  try {
    await markUsed(detail.value.id);
    used.value = true;
    detail.value.use_count += 1;
    detail.value.last_used_at = new Date().toISOString();
    message.success('已记录使用');
    emit('saved');
  } catch (e) {
    message.error((e as Error).message);
  }
}

function canEdit(k: KnowledgeRow): boolean {
  return currentUser.value?.role === 'admin' || currentUser.value?.username === k.author;
}

const statusMeta: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  verified: { color: 'green', label: '已验证' },
  deprecated: { color: 'red', label: '已废弃' },
};

const kindLabel: Record<string, string> = {
  content: '内容修改',
  status: '状态流转',
};

/** changes 摘要：字段名 + 旧值 JSON（超 120 字符截断），供单行展示 */
function changesSummary(rev: Revision): string {
  const changes = rev.changes ?? {};
  const fields = Object.keys(changes).join('、');
  const json = JSON.stringify(changes);
  return `${fields ? `${fields}：` : ''}${json.length > 120 ? `${json.slice(0, 120)}…` : json}`;
}
</script>

<template>
  <a-drawer
    :open="id !== null"
    :title="detail?.title ?? '详情'"
    width="560"
    @close="emit('update:id', null)"
  >
    <a-spin :spinning="loading">
      <template v-if="detail">
        <a-space wrap style="margin-bottom: 16px">
          <a-tag :color="statusMeta[detail.status]?.color ?? 'default'">
            {{ statusMeta[detail.status]?.label ?? detail.status }}
          </a-tag>
          <a-tag color="blue">{{ detail.domain }}</a-tag>
          <a-tag>{{ detail.scope }}</a-tag>
          <a-tag v-if="detail.module">{{ detail.module }}</a-tag>
        </a-space>

        <a-descriptions :column="1" size="small" bordered>
          <a-descriptions-item label="现象">
            <div style="white-space: pre-wrap">{{ detail.symptom }}</div>
          </a-descriptions-item>
          <a-descriptions-item label="解决">
            <div style="white-space: pre-wrap">{{ detail.solution }}</div>
          </a-descriptions-item>
          <a-descriptions-item v-if="detail.detail" label="详情">
            <div style="white-space: pre-wrap">{{ detail.detail }}</div>
          </a-descriptions-item>
          <a-descriptions-item v-if="detail.code_ref" label="代码位置">
            <a-typography-text code>{{ detail.code_ref }}</a-typography-text>
          </a-descriptions-item>
          <a-descriptions-item v-if="detail.tags.length" label="标签">
            <a-tag v-for="t in detail.tags" :key="t">{{ t }}</a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="记录">
            {{ detail.author }} · 用过 {{ detail.use_count }} 次 · 最近 <RelativeTime :time="detail.last_used_at" />
          </a-descriptions-item>
        </a-descriptions>

        <a-space style="margin-top: 16px">
          <a-button type="primary" :disabled="used" @click="onMarkUsed">
            <template #icon><CheckCircleFilled /></template>
            {{ used ? '已记录' : '帮到了我' }}
          </a-button>
          <a-button v-if="canEdit(detail)" @click="emit('edit', detail)">
            <template #icon><EditOutlined /></template>
            编辑
          </a-button>
        </a-space>

        <a-collapse style="margin-top: 16px">
          <a-collapse-panel key="revisions" header="修订历史">
            <a-spin v-if="revisionsLoading" size="small" />
            <a-empty v-else-if="!revisions?.length" description="暂无修订" />
            <div v-else class="revision-list">
              <div v-for="(rev, index) in revisions" :key="`${rev.version}-${index}`" class="revision-item">
                <div class="revision-meta">
                  <a-tag :color="rev.kind === 'status' ? 'orange' : 'blue'">
                    {{ kindLabel[rev.kind] ?? rev.kind }}
                  </a-tag>
                  <span>v{{ rev.version }} · {{ rev.changedBy }} · <RelativeTime :time="rev.createdAt" /></span>
                </div>
                <div class="revision-changes" :title="JSON.stringify(rev.changes ?? {})">
                  {{ changesSummary(rev) }}
                </div>
              </div>
            </div>
          </a-collapse-panel>
        </a-collapse>
      </template>
      <a-empty v-else-if="!loading" description="无内容" />
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.revision-item {
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}
.revision-item:last-child {
  border-bottom: none;
}
.revision-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.revision-changes {
  font-size: 12px;
  color: #666;
  word-break: break-all;
}
</style>
