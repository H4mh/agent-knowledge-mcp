<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ time: string | null }>();

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 周前 / 超过一个月显示日期 */
const text = computed(() => {
  if (!props.time) return '—';
  const then = new Date(props.time).getTime();
  if (Number.isNaN(then)) return props.time;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 14) return `${day} 天前`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week} 周前`;
  return new Date(props.time).toLocaleDateString('zh-CN');
});
</script>

<template>
  <span>{{ text }}</span>
</template>
