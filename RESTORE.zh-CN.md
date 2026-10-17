# 在另一台 Windows 电脑重建协作工作区

本仓库保存 Antigravity（Gemini）与 Codex CLI 协作桥的完整源码、协作规则、项目模板、测试和 Windows 安装包构建脚本。保留原项目 Git 历史。`AI_HANDOFF.md` 是原电脑的历史记录，其中的路径、写授权和测试结果不代表新电脑当前状态。

## 1. 准备环境

- Windows 10 / 11，Windows PowerShell 5.1。
- Git、Node.js 22（与仓库 CI 一致），确保 `git`、`node`、`npm` 在 PATH 中。
- 安装 Antigravity，并在新电脑自行登录 Gemini 账号。
- 安装并登录 Codex CLI。安装命令和登录方式以 https://developers.openai.com/codex/cli 为准。
- 如需构建 EXE，需有 Windows .NET Framework 4 的 `csc.exe`；构建脚本会检查。

本项目只使用 Node.js 内置模块，不需要执行 `npm install`。账号、订阅和 CLI 兼容性需要在新电脑单独确认，仓库不包含登录凭据。

## 2. 克隆并验证源码

在 GitHub 仓库页面复制 HTTPS 克隆地址，用它替换下面的 `<仓库HTTPS地址>`：

```powershell
New-Item -ItemType Directory -Force "$HOME\Projects" | Out-Null
git clone <仓库HTTPS地址> "$HOME\Projects\Antigravity-Codex-Workspace"
Set-Location "$HOME\Projects\Antigravity-Codex-Workspace"
node --version
git --version
codex --version
node --test test/codex-bridge.test.cjs test/global-bridge.test.cjs test/deploy.test.cjs test/t008-workflow.test.cjs
```

测试会使用临时目录和模拟 Codex；它不能代替真实账号登录及 Antigravity 端到端验证。

## 3. 构建和安装全局桥

```powershell
powershell -ExecutionPolicy Bypass -File .\build-exe.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 install -TrustRoot "$HOME\Projects"
node .\deploy.cjs doctor
node .\deploy.cjs status
```

安装将部署 `$HOME\.dual-agent`、全局技能 `$HOME\.gemini\config\skills\codex-delegate\SKILL.md`，并配置当前用户的登录自启动和后台桥。运行前检查安装输出；`doctor` 应报告 `healthy: true`。可用 `node .\deploy.cjs stop` 停止桥，`node .\deploy.cjs start` 重新启动。

构建生成 `dist\DualAgentSetup.exe`、`dual-agent-launcher.exe`、`dual-agent-bundle.zip` 和 `SHA256SUMS.txt`。可将生成的安装包带到另一台 Windows 电脑；Node.js、Git、Codex CLI 和 Antigravity 仍需单独安装。

## 4. 恢复协作项目

在 Antigravity 中打开刚克隆的目录，阅读 `GEMINI.md`、`AI_HANDOFF.md` 以及 `.agents\skills\codex-delegate\SKILL.md`。全局技能安装后若未显示，重启 Antigravity 并检查技能路径。

若要让 Codex 修改这个项目，在新电脑显式登记写授权：

```powershell
$clientScript = Join-Path $HOME '.dual-agent\client.cjs'
$projectDir = (Get-Location).Path
node $clientScript authorize-write --project $projectDir
node $clientScript check-project --project $projectDir --mode write
node $clientScript run --project $projectDir --mode read --task-type REVIEW --prompt 'Read README.md and report the project purpose. Do not modify files.'
```

检查任务结果及桥状态，确认真实 Codex 调用成功，然后在 Antigravity 中要求 Gemini 按 `codex-delegate` 技能委派一项小任务，完成实际协作验证。

对新的业务项目，先创建 Git 仓库，再在本仓库目录运行：

```powershell
node .\deploy.cjs init-project --project "$HOME\Projects\MyApp" --register
```

此命令写入协作模板，默认不覆盖现有文件。读登记不等于写授权，需要写入时对目标项目另行运行 `authorize-write`。

## 5. 文件和机器状态的边界

| 内容 | 位置 / 恢复方式 |
| --- | --- |
| 全局桥和客户端源码 | `global/bridge.cjs`、`global/client.cjs` |
| 单项目旧版桥 | `codex-bridge.cjs`，保留以供历史兼容 |
| 安装及打包 | `deploy.cjs`、`install.ps1`、`build-exe.ps1` |
| 工作分工及交接 | `GEMINI.md`、`AI_HANDOFF.md` |
| 可复用项目模板 | `templates/` |
| 测试及发布 | `test/`、`.github/workflows/release.yml` |
| 本机注册、授权及绝对路径 | 新电脑安装后重新建立，不复制旧 `projects.json` |
| 任务队列、日志、PID 和锁文件 | 运行时重新生成，不迁移 |
| Codex / Gemini / GitHub 凭据 | 在新电脑自行登录，不提交至 Git |

不要复制旧电脑的 `bridge.lock` 或 `status.json`，也不要把整个用户目录或 `.codex`、`.gemini` 登录配置上传。若新机 CLI 不再支持桥源码里的 `windows.sandbox=mxc` 参数，先解决 CLI 兼容性；不要通过关闭隔离绕过错误。
