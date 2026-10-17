# 依赖与配置清单

## 本项目的依赖边界

仓库包含所有桥接业务源码、安装与打包脚本、协作技能、模板和 32 项测试。桥接代码只使用 Node.js 内置模块；`package.json` 的运行和开发依赖均为空。无需安装项目 npm 包，也没有需要复制的 `node_modules`。`package-lock.json` 固定本项目清单，不固定全局工具或操作系统。

## 外部工具

| 工具 | 用途 / 获取渠道 | 版本依据 |
| --- | --- | --- |
| Windows 10/11 | 桥使用 cmd.exe、taskkill、注册表及计划任务 | 项目面向 Windows |
| Node.js + npm | 执行源码与测试；https://nodejs.org/ | CI 使用 Node 22；本次本机测试使用 24.20.0、npm 12.0.2 |
| Git | Git 项目根目录检测与克隆；https://git-scm.com/ | 本机 Git 2.55.0.windows.5 |
| Codex CLI npm 发行版 | 桥实际执行 `codex.cmd`；https://developers.openai.com/codex/cli | 本机 npm 包 `@openai/codex` 为 0.163.0，`codex.cmd --version` 也是 0.163.0 |
| Antigravity | Gemini 侧读取规则、委派与验证；https://antigravity.google/ | 本次未可靠取得版本，不宣称已锁定 |
| Windows PowerShell 5.1 | install.ps1 和可选 EXE 构建 | Windows 系统组件 |
| .NET Framework 4 csc.exe | 仅构建 EXE 时需要；从 Windows / Microsoft 官方组件获取 | build-exe.ps1 会检查 Framework64 或 Framework 路径 |
| GitHub CLI | 仅维护者上传所需；https://cli.github.com/ | 在新电脑运行桥不需要 |

这些系统依赖使用官方发行物安装，不把第三方安装器或账号凭据放进仓库。本仓库不能提供完全离线的第三方软件安装。

## 复现 Codex npm 版本

下面是复现当前机器实际 `codex.cmd` 版本的命令，不是对该版本未来可用性或兼容性的保证：

```powershell
npm install -g @openai/codex@0.163.0
where.exe codex.cmd
codex.cmd --version
```

按官方流程在新电脑登录。桥默认传入 `-c windows.sandbox=mxc`、`exec`、`--sandbox read-only|workspace-write`、`--ephemeral` 和 `--output-last-message`。新机需实测这些参数兼容性。

本机另有桌面程序自带的 `codex.exe 0.146.1`。仅看 `codex --version` 可能检查到另一份程序，因此必须检查 `codex.cmd`。32 项测试验证桥与模拟 CLI 的行为及隔离安装；本次没有重新执行真实模型协作端到端测试。

## 配置项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| DUAL_AGENT_HOME | `$HOME\.dual-agent` | 桥、注册表文件、任务队列和日志目录 |
| DUAL_AGENT_SKILL_PATH | `$HOME\.gemini\config\skills\codex-delegate\SKILL.md` | 安装器写入全局技能的位置 |
| DUAL_AGENT_NO_AUTOSTART | 未设置 | 为 `1` 时安装器跳过自启动注册 |
| CODEX_BRIDGE_POLL_MS | 1000 | 桥轮询间隔，毫秒 |
| CODEX_BRIDGE_TIMEOUT_MS | 300000 | 单任务超时，毫秒 |
| CODEX_BRIDGE_KILL_GRACE_MS | 5000 | 终止进程等待时间，毫秒 |

`config/environment.example.ps1` 是可审阅的进程级示例；在同一 PowerShell 中 `. .\config\environment.example.ps1` 后再安装和启动。环境不会自动持久化，桥不会加载 `.env`。默认路径无需设置环境变量。

源码还支持 `CODEX_BRIDGE_CMD`、`CODEX_BRIDGE_TASKKILL_CMD` 以及测试故障注入变量。这些属于自定义执行或测试入口，正常迁移无需设置。

项目路径、可信父目录与写授权由客户端建立。源码安装示例见 `RESTORE.zh-CN.md`。不复制原电脑 `projects.json` 的绝对路径，也不把历史交接文件中的授权视为新机授权。
