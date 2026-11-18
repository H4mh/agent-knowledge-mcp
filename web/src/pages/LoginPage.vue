<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { KeyOutlined } from '@ant-design/icons-vue';
import { login, UnauthorizedError } from '../auth';

/**
 * 独立登录页：token 输入 + 登录 + 错误提示（原 App.vue 模态框逻辑迁移）。
 * 登录成功后回跳 redirect（仅允许站内路径，防开放重定向；redirect 为 /login 自身时回检索页），默认回检索页。
 */
const router = useRouter();
const route = useRoute();

const tokenInput = ref('');
const loginError = ref('');
const loginLoading = ref(false);

const redirectTarget = computed<string | null>(() => {
  const r = route.query.redirect;
  if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && r !== '/login') return r;
  return null;
});

async function submitLogin(): Promise<void> {
  if (!tokenInput.value.trim()) { loginError.value = '请输入身份令牌'; return; }
  loginLoading.value = true;
  loginError.value = '';
  try {
    await login(tokenInput.value.trim());
    tokenInput.value = '';
    await router.push(redirectTarget.value ?? { name: 'search' });
  } catch (e) {
    loginError.value = e instanceof UnauthorizedError ? e.message : (e as Error).message;
  } finally {
    loginLoading.value = false;
  }
}
</script>

<template>
  <div class="login-wrapper">
    <a-card class="login-card" :bordered="false">
      <div class="login-title">
        <KeyOutlined style="font-size: 28px; color: #1677ff" />
        <h2>登录团队知识库</h2>
        <p class="login-hint">令牌由 agent 端首次使用自动生成，或由管理员发放</p>
      </div>
      <a-form layout="vertical" @submit.prevent="submitLogin">
        <a-form-item label="身份令牌">
          <a-input-password
            v-model:value="tokenInput"
            placeholder="粘贴身份令牌"
            size="large"
            @press-enter="submitLogin"
          />
        </a-form-item>
        <a-button type="primary" size="large" block :loading="loginLoading" @click="submitLogin">
          登录
        </a-button>
        <a-alert v-if="loginError" style="margin-top: 16px" type="error" :message="loginError" show-icon />
      </a-form>
    </a-card>
  </div>
</template>

<style scoped>
.login-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 120px);
}
.login-card {
  width: 100%;
  max-width: 400px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}
.login-title {
  text-align: center;
  margin-bottom: 24px;
}
.login-title h2 {
  margin: 12px 0 4px;
  font-size: 20px;
}
.login-hint {
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
  margin: 0;
}
</style>
