---
name: 修复 TypeScript 类型错误
description: 系统性定位并修复 TS 编译/类型报错（tsc / 编辑器诊断），区分真实错误与配置噪声
category: debug
tags: [typescript, ts, 类型, type, 编译, tsc]
trigger: 类型错误,type error,tsc,TS2,TS7,类型不匹配,类型推断,strict
author: pancode
version: 1.0.0
---

## 解决方案
1. 先跑 `npx tsc --noEmit` 拿完整错误清单（不要只看编辑器零星红线）。
2. 按错误码分类处理：
   - `TS2xxx` 类型不存在/导入失败 → 检查 import 路径、依赖是否安装、`tsconfig` 的 `moduleResolution`。
   - `TS23xx/2345` 参数/赋值类型不匹配 → 看是「真的类型错」还是「你期望的类型更宽」；必要时收窄/放宽类型或加类型守卫。
   - `TS7xxx` 表达式不可调用/属性不存在 → 多半是 `any` 丢失类型 or 第三方库缺 `@types`，先补类型而非 `as any` 糊弄。
3. 优先用精确类型（收窄联合、类型守卫、`ReturnType`/`Parameters` 推导）替代 `any` / `@ts-ignore`；万不得已用 `as` 时注明原因。
4. 改完再跑 `tsc --noEmit` 确认 0 错误。

## 验证
`npx tsc --noEmit` 退出码为 0；相关文件在编辑器无类型红线。
