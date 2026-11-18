---
title: MyBatis 分页失效返回全量数据
symptom: 分页查询未生效，接口返回全量数据
solution: 显式引入 pagehelper-spring-boot-starter 2.x，并确认 PageHelper 拦截器在 MyBatis 插件链首位
domain: java
scope: demo-app
module: core/Service
tags: [mybatis, mysql]
code_ref: core/Service/web/pom.xml
status: verified
author: seed
---

排查要点：

1. 检查 pom 是否引入 `pagehelper-spring-boot-starter`，仅引入 pagehelper 核心 jar 不会自动装配。
2. 多数据源场景下确认拦截器对目标 SqlSessionFactory 生效。
3. 验证方法：开启 SQL 日志，确认最终执行的 SQL 带 LIMIT 子句。
