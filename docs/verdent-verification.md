# Verdent 验证

所有公开测试和示例均为人工合成数据，不包含个人账户标识、登录信息、真实消费记录或本机采集结果。验证报告、截图和运行日志仅写入被忽略的 `tmp/`。

## 可复现检查

- `node --test tests/electron/verdent*.test.js`：解析、分页、相同记录保留、快照覆盖、失败保留、账号隔离、日期边界、Eco 分组、模型别名及断点复用；另覆盖三个月日历边界、旧固定范围迁移、在线保留期滚动归档、系统时间回退及原子写盘失败。
- `npm run verify:verdent:electron`：独立测试账号槽运行真实 Electron，验证设置、管理页、主页、Dashboard、Credits 和 Eco 显示，使用合成数据。
- `npm run verify:verdent:login`：真实 Electron 拦截网络，验证 Google OAuth 回调页面恢复、本地化 Dashboard、子窗口查询及快照保存。不会访问个人账号。
- `npm run verify:privacy`：检查可加入 Git 的运行数据路径和当前 Git 索引，包含对已暂存内容的检查。
- `npm run verify`：隐私检查、lint 和全部测试。

增量分页使用倒序记录及两页匹配边界，保留同秒重复记录的数量。旧尾部可能被服务端修改；手动三个月回溯负责校正，增量匹配不是全历史再次验证。

## 已知限制

真实账号的完整分页合计、七个单日与周范围一致性、日期端点语义及后台 `session.fetch` 需由使用者在自己的登录环境中验证，结果不要提交至仓库。截图捕获依赖可用的 Windows 合成器；`UnknownVizError` 不代表 DOM/IPC 断言失败，但不能据此宣称视觉验收通过。

Windows 全套回归仍存在已在未修改上游复现的四个环境相关失败：agent titleSync 子进程、Cline/Copilot 本机源探测和 Cherry Studio SHM watcher 扫描数量；不将全套报告为全部通过。
