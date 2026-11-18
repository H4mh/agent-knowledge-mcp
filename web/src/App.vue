<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { UserOutlined, LogoutOutlined, KeyOutlined } from '@ant-design/icons-vue';
import { currentUser, isAdmin, logout } from './auth';

const router = useRouter();
const route = useRoute();

function goLogin(): void {
  // 登录入口改为独立 /login 页，携带当前路径便于登录后回跳（已在 /login 时不带 redirect，避免回跳自身）
  if (route.name === 'login') return;
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}

function onLogout(): void {
  logout();
  if (route.path.startsWith('/admin')) router.push({ name: 'search' });
}

const selectedKeys = computed(() => [route.name as string]);
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-header class="app-header">
      <span class="brand" @click="router.push({ name: 'search' })">团队知识库</span>
      <a-menu
        theme="dark"
        mode="horizontal"
        :selected-keys="selectedKeys"
        class="nav-menu"
      >
        <a-menu-item key="search" @click="router.push({ name: 'search' })">检索</a-menu-item>
        <a-menu-item key="skills" @click="router.push({ name: 'skills' })">Skills</a-menu-item>
        <a-menu-item key="stats" @click="router.push({ name: 'stats' })">统计</a-menu-item>
        <a-menu-item v-if="isAdmin" key="admin-knowledge" @click="router.push({ name: 'admin-knowledge' })">管理后台</a-menu-item>
      </a-menu>
      <div class="user-area">
        <template v-if="currentUser">
          <a-space>
            <UserOutlined />
            <span>{{ currentUser.username }}</span>
            <a-button type="text" size="small" @click="onLogout">
              <template #icon><LogoutOutlined /></template>
              退出
            </a-button>
          </a-space>
        </template>
        <a-button v-else type="primary" size="small" @click="goLogin">
          <template #icon><KeyOutlined /></template>
          登录
        </a-button>
      </div>
    </a-layout-header>
    <a-layout-content class="app-content">
      <router-view />
    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  padding: 0 24px;
}
.brand {
  color: #fff;
  font-size: 17px;
  font-weight: 600;
  margin-right: 32px;
  cursor: pointer;
  white-space: nowrap;
}
.nav-menu {
  flex: 1;
  min-width: 0;
}
.user-area {
  color: #fff;
  white-space: nowrap;
}
.app-content {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
</style>
