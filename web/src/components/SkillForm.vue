<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue';
import { getSkill, saveSkill, updateSkill, type SkillFile, type SaveSkillInput } from '../api';
import { UnauthorizedError } from '../auth';

/**
 * 新增/编辑 Skill 表单（模式照 KnowledgeForm）。
 * name/description/instructions 必填；附加文件动态编辑器：每行 path 输入框 + content textarea，可增删行；
 * 编辑模式经 GET /api/skills/:name 回填后提交 PUT。skill scope 不自动注册，须为已注册 scope（或留空）。
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const props = defineProps<{ open: boolean; editName?: string; scopes: string[] }>();
const emit = defineEmits<{ close: []; saved: [name: string]; view: [name: string] }>();

interface FileRow {
  path: string;
  content: string;
}

const form = ref({
  name: '',
  description: '',
  instructions: '',
  scope: '',
  tags: [] as string[],
});
const files = ref<FileRow[]>([]);
const isEdit = computed(() => props.editName !== undefined);
const submitting = ref(false);

const scopeOptions = computed(() => props.scopes.map((s) => ({ value: s, label: s })));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    submitting.value = false;
    if (props.editName !== undefined) {
      try {
        const s = await getSkill(props.editName);
        form.value = {
          name: s.name,
          description: s.description,
          instructions: s.instructions,
          scope: s.scope ?? '',
          tags: [...s.tags],
        };
        files.value = s.files.map((f) => ({ path: f.path, content: f.content }));
      } catch (e) {
        message.error((e as Error).message);
        emit('close');
      }
    } else {
      form.value = { name: '', description: '', instructions: '', scope: '', tags: [] };
      files.value = [];
    }
  },
);

function addFile(): void {
  files.value.push({ path: '', content: '' });
}

function removeFile(i: number): void {
  files.value.splice(i, 1);
}

function validateFiles(): string | null {
  const seen = new Set<string>();
  for (const f of files.value) {
    const path = f.path.trim();
    if (!path || !f.content.trim()) return '附加文件每行的路径与内容都必须填写（或删除空行）';
    if (seen.has(path)) return `附加文件路径重复: ${path}`;
    seen.add(path);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
      return `附加文件路径非法: ${path}`;
    }
    if (path.toLowerCase() === 'skill.md') return 'SKILL.md 为安装入口保留，不能作为附加文件名';
  }
  return null;
}

function validate(): string | null {
  if (!form.value.name.trim()) return '名称不能为空';
  if (!SKILL_NAME_RE.test(form.value.name.trim())) return '名称须为小写字母/数字开头，仅含小写字母、数字、连字符，长度 2-64';
  if (!form.value.description.trim()) return '描述不能为空';
  if (!form.value.instructions.trim()) return '安装说明（instructions）不能为空';
  return validateFiles();
}

function currentFiles(): SkillFile[] | undefined {
  const list = files.value
    .map((f) => ({ path: f.path.trim(), content: f.content }))
    .filter((f) => f.path && f.content);
  return list.length ? list : undefined;
}

async function onSave(): Promise<void> {
  const err = validate();
  if (err) { message.warning(err); return; }
  submitting.value = true;
  try {
    const input: SaveSkillInput = {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      instructions: form.value.instructions,
      files: currentFiles(),
      scope: form.value.scope || undefined,
      tags: form.value.tags.length ? form.value.tags : undefined,
    };
    const res = await saveSkill(input);
    message.success(res.status === 'draft' ? '已保存（草稿）' : '已保存');
    emit('saved', input.name);
    emit('close');
  } catch (e) {
    message.error(e instanceof UnauthorizedError ? e.message : (e as Error).message);
  } finally {
    submitting.value = false;
  }
}

async function onUpdate(): Promise<void> {
  const err = validate();
  if (err) { message.warning(err); return; }
  submitting.value = true;
  try {
    // 编辑模式 files/tags 显式发 []（空数组整体替换），避免 undefined 被后端视为"保留原值"而静默 no-op；
    // scope 同理：清空发 null（后端置 NULL），留空字符串不能区分"保留"与"清空"
    const trimmedFiles = files.value
      .map((f) => ({ path: f.path.trim(), content: f.content }))
      .filter((f) => f.path && f.content);
    await updateSkill(props.editName as string, {
      description: form.value.description.trim(),
      instructions: form.value.instructions,
      files: trimmedFiles,
      scope: form.value.scope || null,
      tags: form.value.tags,
    });
    message.success('已更新');
    emit('saved', form.value.name.trim());
    emit('close');
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    submitting.value = false;
  }
}

function onSubmit(): void {
  isEdit.value ? onUpdate() : onSave();
}
</script>

<template>
  <a-modal
    :open="open"
    :title="isEdit ? '编辑 Skill' : '新增 Skill'"
    width="720px"
    :ok-button-props="{ loading: submitting }"
    ok-text="保存"
    cancel-text="取消"
    @ok="onSubmit"
    @cancel="emit('close')"
  >
    <a-form layout="vertical">
      <a-row :gutter="12">
        <a-col :span="12">
          <a-form-item label="名称 name">
            <a-input v-model:value="form.name" :disabled="isEdit" placeholder="如：db-query-check（小写-连字符）" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Scope（须已注册）">
            <a-select
              v-model:value="form.scope"
              :options="scopeOptions"
              allow-clear
              placeholder="选择 scope（可留空；skill 是共享资产，不会自动注册）"
            />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="描述 description">
        <a-input v-model:value="form.description" placeholder="一句话说明这个 Skill 做什么" />
      </a-form-item>
      <a-form-item label="安装说明 instructions（SKILL.md 正文）">
        <a-textarea v-model:value="form.instructions" :rows="8" placeholder="安装步骤、前置条件、使用方式（Markdown 文本）" />
      </a-form-item>
      <a-form-item label="标签 tags">
        <a-select v-model:value="form.tags" mode="tags" placeholder="输入后回车添加" />
      </a-form-item>

      <a-divider orientation="left" style="margin-top: 8px">
        附加文件（可选）
        <a-button type="link" size="small" @click="addFile">
          <template #icon><PlusOutlined /></template>
          添加文件
        </a-button>
      </a-divider>
      <div v-for="(f, i) in files" :key="i" class="file-row">
        <div class="file-row-head">
          <a-input v-model:value="f.path" placeholder="相对路径，如 scripts/check.sh" style="flex: 1" />
          <a-button danger size="small" @click="removeFile(i)">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
        <a-textarea v-model:value="f.content" :rows="4" placeholder="文件内容" />
      </div>
    </a-form>
  </a-modal>
</template>

<style scoped>
.file-row {
  margin-bottom: 12px;
}
.file-row-head {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
</style>
