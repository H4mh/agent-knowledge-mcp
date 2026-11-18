<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { getKnowledge, preview, saveKnowledge, updateKnowledge, type SaveInput } from '../api';
import { UnauthorizedError } from '../auth';

/**
 * 新增/编辑知识表单。
 * 新增走 dry-run 预检流：提交先调 preview（不落库），有相似条目时展示卡片，
 * 用户选择「仍要新建」或「去看相似条目」；编辑模式仅 symptom/solution/detail/tags/code_ref/module 可改。
 */
// 与后端 DOMAINS 枚举一致（src/tools/save.ts）
const DOMAINS = ['java', 'frontend', 'mobile', 'infra', 'db', 'workflow'];

const props = defineProps<{ open: boolean; editId?: number; scopes: string[] }>();
const emit = defineEmits<{ close: []; saved: [id: number]; view: [id: number] }>();

const DEFAULT_FORM: SaveInput = {
  title: '',
  symptom: '',
  solution: '',
  detail: '',
  domain: 'java',
  scope: '',
  module: '',
  tags: [],
  code_ref: '',
};

const form = ref<SaveInput>({ ...DEFAULT_FORM });
const isEdit = computed(() => props.editId !== undefined);
const submitting = ref(false);
const previewing = ref(false);

// 预检结果：similar 非空 → 展示相似卡片，两按钮二选一
const similar = ref<{ id: number; title: string; similarity: number }[]>([]);
const warnings = ref<string[]>([]);
const scopeWillRegister = ref(false);
const scopeManual = ref(false);
const manualScope = ref('');

const scopeOptions = computed(() => [
  ...props.scopes.map((s) => ({ value: s, label: s })),
  { value: '__manual__', label: '手动输入…' },
]);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    similar.value = [];
    warnings.value = [];
    scopeWillRegister.value = false;
    scopeManual.value = false;
    manualScope.value = '';
    submitting.value = false;
    if (props.editId !== undefined) {
      try {
        const k = await getKnowledge(props.editId);
        form.value = {
          title: k.title,
          symptom: k.symptom,
          solution: k.solution,
          detail: k.detail ?? '',
          domain: k.domain,
          scope: k.scope,
          module: k.module ?? '',
          tags: k.tags,
          code_ref: k.code_ref ?? '',
        };
      } catch (e) {
        message.error((e as Error).message);
        emit('close');
      }
    } else {
      form.value = { ...DEFAULT_FORM, tags: [] };
    }
  },
);

function validate(): string | null {
  if (!form.value.title.trim()) return '标题不能为空';
  if (!form.value.symptom.trim()) return '现象不能为空';
  if (!form.value.solution.trim()) return '解决方案不能为空';
  const scope = scopeManual.value ? manualScope.value.trim() : form.value.scope;
  if (!scope) return 'Scope 不能为空';
  return null;
}

function currentInput(): SaveInput {
  return {
    ...form.value,
    scope: scopeManual.value ? manualScope.value.trim() : form.value.scope,
    module: form.value.module || undefined,
    code_ref: form.value.code_ref || undefined,
    detail: form.value.detail || undefined,
  };
}

/** 第一步：预检（dry-run，不落库） */
async function onPrecheck(): Promise<void> {
  const err = validate();
  if (err) { message.warning(err); return; }
  previewing.value = true;
  warnings.value = [];
  similar.value = [];
  scopeWillRegister.value = false;
  try {
    const res = await preview(currentInput());
    warnings.value = res.warnings;
    scopeWillRegister.value = res.scopeWillRegister;
    similar.value = res.similar;
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    previewing.value = false;
  }
}

/** 第二步：确认新建（真正落库） */
async function onSave(): Promise<void> {
  submitting.value = true;
  try {
    const res = await saveKnowledge(currentInput());
    message.success(res.scopeRegistered ? '已保存，并注册了新 scope' : '已保存（草稿）');
    emit('saved', res.id);
    emit('close');
  } catch (e) {
    message.error(e instanceof UnauthorizedError ? e.message : (e as Error).message);
  } finally {
    submitting.value = false;
  }
}

/** 编辑模式：直接提交受限字段 */
async function onUpdate(): Promise<void> {
  submitting.value = true;
  try {
    await updateKnowledge(props.editId as number, {
      symptom: form.value.symptom,
      solution: form.value.solution,
      detail: form.value.detail || undefined,
      module: form.value.module || undefined,
      tags: form.value.tags,
      code_ref: form.value.code_ref || undefined,
    });
    message.success('已更新');
    emit('saved', props.editId as number);
    emit('close');
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    submitting.value = false;
  }
}

function viewSimilar(id: number): void {
  emit('view', id);
  emit('close');
}
</script>

<template>
  <a-modal
    :open="open"
    :title="isEdit ? '编辑知识条目' : '新增知识条目'"
    width="680px"
    :ok-button-props="{ loading: submitting || previewing }"
    :ok-text="isEdit ? '保存' : similar.length ? '仍要新建' : '预检'"
    cancel-text="取消"
    @ok="isEdit ? onUpdate() : similar.length ? onSave() : onPrecheck()"
    @cancel="emit('close')"
  >
    <a-alert
      v-if="scopeWillRegister"
      type="warning"
      show-icon
      message="Scope 尚不存在，保存后将自动注册该 scope"
      style="margin-bottom: 12px"
    />
    <a-alert
      v-for="(w, i) in warnings"
      :key="i"
      type="warning"
      show-icon
      :message="w"
      style="margin-bottom: 12px"
    />

    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item label="标题">
            <a-input v-model:value="form.title" :disabled="isEdit" placeholder="一句话概括这个问题" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="领域 domain">
            <a-select v-model:value="form.domain" :disabled="isEdit" :options="DOMAINS.map((d) => ({ value: d, label: d }))" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Scope">
            <a-select
              v-if="!scopeManual"
              v-model:value="form.scope"
              :disabled="isEdit"
              :options="scopeOptions"
              placeholder="选择 scope"
              @change="(v: unknown) => { if (v === '__manual__') { scopeManual = true; } }"
            />
            <a-input v-else v-model:value="manualScope" :disabled="isEdit" placeholder="输入新 scope（小写-短横线）" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="模块 module（可选）">
            <a-input v-model:value="form.module" placeholder="如：auth-service" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="现象 symptom">
        <a-textarea v-model:value="form.symptom" :rows="3" placeholder="遇到什么问题？报错/表现是什么" />
      </a-form-item>
      <a-form-item label="解决 solution">
        <a-textarea v-model:value="form.solution" :rows="4" placeholder="怎么解决的？关键步骤" />
      </a-form-item>
      <a-form-item label="详情 detail（可选）">
        <a-textarea v-model:value="form.detail" :rows="4" placeholder="背景、排查过程、注意事项" />
      </a-form-item>
      <a-form-item label="代码位置 code_ref（可选）">
        <a-input v-model:value="form.code_ref" placeholder="如：repo/path/file.ts:123" />
      </a-form-item>
      <a-form-item label="标签 tags">
        <a-select v-model:value="form.tags" mode="tags" placeholder="输入后回车添加" />
      </a-form-item>
    </a-form>

    <template v-if="!isEdit && similar.length">
      <a-divider>相似条目（{{ similar.length }}）</a-divider>
      <a-card v-for="s in similar" :key="s.id" size="small" style="margin-bottom: 8px">
        <template #title>
          <a @click="viewSimilar(s.id)">{{ s.title }}</a>
        </template>
        相似度 {{ (s.similarity * 100).toFixed(0) }}%
        <a-button type="link" size="small" @click="viewSimilar(s.id)">去看相似条目</a-button>
      </a-card>
    </template>
  </a-modal>
</template>
