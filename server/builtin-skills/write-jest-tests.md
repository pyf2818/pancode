---
name: 编写 Jest 单元测试
description: 为模块/函数编写可维护的 Jest 测试，覆盖正常、边界与异常路径
category: test
tags: [jest, 测试, unit, test, 单测, 覆盖率, mock]
trigger: 测试,jest,单测,覆盖率,unit test,写用例,补测试
author: pancode
version: 1.0.0
---

## 解决方案
1. 被测文件 `src/foo.ts` 对应测试放 `src/foo.test.ts`（或 `__tests__/foo.test.ts`）。
2. 每个测试只验证一个行为，用 `describe` 分组、`it` 命名「应当…当…」：
   - 正常路径：给定输入得到预期输出。
   - 边界：空值、0、超大数、极值。
   - 异常：`expect(() => fn()).toThrow()` 或 `rejects.toThrow()`。
3. 依赖外部（DB/网络/时间）用 `jest.mock` 隔离；用 `mockReturnValue` / `mockImplementation` 控制返回值，`toHaveBeenCalledWith` 断言调用。
4. 异步用 `async/await` + `await expect(p).resolves`；定时器用 `jest.useFakeTimers()`。
5. 跑 `npx jest src/foo.test.ts` 看是否全绿。

## 验证
`npx jest` 相关用例全过；`npx jest --coverage` 关注目标模块覆盖率（核心逻辑 ≥ 80%）。
