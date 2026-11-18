<script setup lang="ts">
import { ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons-vue';
import { fetchRevisions, getSkill, deleteSkill, type Revision, type SkillDetail } from '../api';
import { currentUser } from '../auth';
import RelativeTime from './RelativeTime.vue';

/**
 * Skill 详情抽屉：props.name 为 null 表示关闭；
 * 元信息 + instructions（SKILL.md 安装说明）+ 附加文件逐个 <pre> 代码块预览；
 * 编辑/删除按钮仅 author 或 admin 可见，删除二次确认后调 DELETE 并 emit saved。
 */
const props = defineProps<{ name: string | null }>();
const emit = defineEmits<{ 'update:name': [name: string | null]; edit: [s: SkillDetail]; saved: [] }>();

const detail = ref<SkillDetail | null>(null);
const loading = ref(false);
const deleting = ref(false);
// 请求时序守卫：快速切换目标时仅最新一次请求可写入 detail
let fetchSeq = 0;

// 修订历史：打开抽屉时懒加载，失败静默降级（面板空态，不阻塞详情）
const revisions = ref<Revision[] | null>(null);
const revisionsLoading = ref(false);
let revisionSeq = 0;

watch(
  () => props.name,
  async (name) => {
    revisions.value = null;
    const seq = ++revisionSeq;
    if (name === null) return;
    revisionsLoading.value = true;
    try {
      const rows = await fetchRevisions('skill', name);
      if (seq === revisionSeq) revisions.value = rows;
    } catch {
      /* 静默降级：修订历史获取失败不提示、不影响详情展示 */
    } finally {
      if (seq === revisionSeq) revisionsLoading.value = false;
    }
  },
);

watch(
  () => props.name,
  async (name) => {
    detail.value = null;
    if (name === null) return;
    const seq = ++fetchSeq;
    loading.value = true;
    try {
      const s = await getSkill(name);
      if (seq === fetchSeq) detail.value = s;
    } catch (e) {
      if (seq === fetchSeq) {
        message.error((e as Error).message);
        emit('update:name', null);
      }
    } finally {
      if (seq === fetchSeq) loading.value = false;
    }
  },
);

function canEdit(s: SkillDetail): boolean {
  return currentUser.value?.role === 'admin' || currentUser.value?.username === s.author;
}

async function onDelete(): Promise<void> {
  if (detail.value === null || deleting.value) return;
  deleting.value = true;
  try {
    await deleteSkill(detail.value.name);
    message.success('已删除');
    emit('saved');
    emit('update:name', null);
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    deleting.value = false;
  }
}

const statusMeta: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  verified: { color: 'green', label: '已验证' },
  deprecated: { color: 'orange', label: '已废弃' },
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
    :open="name !== null"
    :title="detail?.name ?? 'Skill 详情'"
    width="640"
    @close="emit('update:name', null)"
  >
    <a-spin :spinning="loading">
      <template v-if="detail">
        <a-space wrap style="margin-bottom: 16px">
          <a-tag :color="statusMeta[detail.status]?.color ?? 'default'">
            {{ statusMeta[detail.status]?.label ?? detail.status }}
          </a-tag>
          <a-tag v-if="detail.scope">{{ detail.scope }}</a-tag>
          <a-tag>v{{ detail.version }}</a-tag>
          <a-tag v-for="t in detail.tags" :key="t">{{ t }}</a-tag>
        </a-space>

        <a-descriptions :column="1" size="small" bordered style="margin-bottom: 16px">
          <a-descriptions-item label="描述">
            <div style="white-space: pre-wrap">{{ detail.description }}</div>
          </a-descriptions-item>
          <a-descriptions-item label="作者">
            {{ detail.author }} · 用过 {{ detail.use_count }} 次 · 最近 <RelativeTime :time="detail.last_used_at" />
          </a-descriptions-item>
          <a-descriptions-item label="更新">
            <RelativeTime :time="detail.updated_at" />
          </a-descriptions-item>
        </a-descriptions>

        <a-divider orientation="left" style="margin-top: 0">SKILL.md 安装说明</a-divider>
        <div class="instructions">{{ detail.instructions }}</div>

        <template v-if="detail.files.length">
          <a-divider orientation="left">附加文件（{{ detail.files.length }}）</a-divider>
          <div v-for="f in detail.files" :key="f.path" class="file-block">
            <div class="file-path">{{ f.path }}</div>
            <pre class="file-content"><code>{{ f.content }}</code></pre>
          </div>
        </template>

        <a-space style="margin-top: 16px">
          <a-button v-if="canEdit(detail)" type="primary" @click="emit('edit', detail)">
            <template #icon><EditOutlined /></template>
            编辑
          </a-button>
          <a-popconfirm
            v-if="canEdit(detail)"
            title="确定删除该 Skill？将同时清除其使用记录"
            ok-text="删除"
            cancel-text="取消"
            :ok-button-props="{ danger: true, loading: deleting }"
            @confirm="onDelete"
          >
            <a-button danger>
              <template #icon><DeleteOutlined /></template>
              删除
            </a-button>
          </a-popconfirm>
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
.instructions {
  white-space: pre-wrap;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 4px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
}
.file-block {
  margin-bottom: 12px;
}
.file-path {
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}
.file-content {
  margin: 0;
  padding: 12px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 4px;
  overflow: auto;
  max-height: 320px;
  font-size: 12px;
  line-height: 1.5;
}
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
