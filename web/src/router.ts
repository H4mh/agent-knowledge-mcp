import { createRouter, createWebHistory } from 'vue-router';
import { message } from 'ant-design-vue';
import { currentUser, loadMe } from './auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'search', component: () => import('./pages/SearchPage.vue') },
    { path: '/skills', name: 'skills', component: () => import('./pages/SkillsPage.vue') },
    { path: '/stats', name: 'stats', component: () => import('./pages/StatsPage.vue') },
    // /login 不加 auth meta，防止未登录时守卫回环
    { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
    { path: '/admin', name: 'admin-knowledge', component: () => import('./pages/AdminKnowledge.vue'), meta: { admin: true, auth: true } },
    { path: '/admin/scopes', name: 'admin-scopes', component: () => import('./pages/AdminScopes.vue'), meta: { admin: true, auth: true } },
    { path: '/admin/users', name: 'admin-users', component: () => import('./pages/AdminUsers.vue'), meta: { admin: true, auth: true } },
  ],
});

router.beforeEach(async (to) => {
  if (!currentUser.value) await loadMe();
  if (to.meta.auth && !currentUser.value) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.admin && currentUser.value?.role !== 'admin') {
    message.warning('该页面仅管理员可访问');
    return { name: 'search' };
  }
  return true;
});
