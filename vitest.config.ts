import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 所有测试共享同一个物理测试库（TEST_DATABASE_URL），文件间必须串行
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
