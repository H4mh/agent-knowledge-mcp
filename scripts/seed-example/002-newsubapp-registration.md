---
title: Qiankun 微前端新增子应用需四处注册
symptom: 新增 subapp 后启动报错或路由 404
solution: 同步修改 pnpm-workspace.yaml、根 package.json 的 serve:xxx 脚本、portal/.env.development 的 VUE_APP_XXX、portal/src/micro/index.js 注册项
domain: frontend
scope: global
module: core/MicroFront
tags: [qiankun, vue]
status: verified
author: seed
---

任何一处遗漏都会导致子应用无法访问。验证方法：`pnpm serve:<xxx>` 启动单应用后从 portal 路由进入。
