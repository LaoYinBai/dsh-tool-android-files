# Changelog

本文件记录面向用户的变更。版本遵循 `MAJOR.MINOR.PATCH`：MAJOR 表示计划格式或安全不变量变化，
MINOR 表示新增操作类型或工具，PATCH 表示修复与文案。

## 1.1.0

首次发布到 npm，并改为 MIT 许可。

- `license` 由 `UNLICENSED` 改为 `MIT`，新增 `LICENSE` 文件，版权人 `LaoYinBai`。
- 补充 `repository` / `homepage` / `bugs` / `author` 与 `publishConfig.access=public`，
  使 `npm publish` 无需额外参数即可发布为公开的 scoped 包。
- 发布物包含 `CHANGELOG.md`。
- 安装方式增加 npm 包名，与 git 安装并存。
- 运行时行为与 1.0.1 完全一致。

## 1.0.0

首个正式版本。四种计划模式：`dedupe`（去重隔离）、`archive`（按类别+月份归档）、
`rename`（把扩展名后的编号移到扩展名前）、`restore`（回到原路径）。

### 工程收尾

- 许可：`package.json` 标记 `UNLICENSED`，仓库不授予复用许可；如需开源请自行添加 LICENSE。
- 新增 CI：push 与 PR 时在 Node 22/24 上运行 `node --test` 与 `npm run check`。
- 新增 `docs/ARCHITECTURE.md`：状态机、安全不变量、失败语义、为什么不用 `rename`。

### 未纳入 1.0.0

- **任务进度事件（`ctx.jobs`）**：长任务仍是一次阻塞的工具调用。进度需要宿主的 job 生命周期契约
  （后台句柄 + 第二个读取进度的工具），盲写会给出错误的接口承诺，因此留到有契约之后再实现。
- **5 GB 单文件**流式哈希未实测，仅有 512 MiB 的证据（判据相同，方法见 README §12）。

## 0.7.1

- 修复：移动不再改写目标的时间戳。`copyFile` 会把 mtime 刷成"现在"，而归档布局正是按修改月份推导的。
  现在复制后把源的 atime/mtime 写回，失败只记 `times-not-preserved` 日志，不阻塞移动。

## 0.7.0

- 新增 `af_plan_archive`：把扫描根目录**顶层**文件按 `<类别>/<YYYY-MM>/` 归档。
  子目录不动（因此二次运行天然幂等），保护文件跳过，目标已存在则取空闲编号。
- 执行器支持无预计算哈希的操作：归档时不预先哈希全部文件，改为执行时逐项现算，避免计划创建阻塞。
- 归档计划在创建时重新 `lstat` 每个候选，用当下身份而非索引快照（恢复过的文件 inode 已变）。

## 0.6.x

- 0.6.2：验证部分执行的计划可以只回滚真正移走的项。
- 0.6.1：清理指引改为带身份校验，移除 `rm -rf`。
- 0.6.0：执行前空间预检（总需量 + 64 MiB 余量）；`af_scan` 上报 `peak_rss_mb`；新增 README §12 验收手册。

## 0.5.x

- 0.5.1：为历史恢复计划回填 `source_plan_id`（从隔离路径反推），并标记前向计划为 `restored`。
- 0.5.0：计划互指（`undoes=` / `restored_by=`）；恢复完成后标记源计划；执行摘要按 mode 输出正确方向；
  恢复后清理空隔离目录。

## 0.4.0

- 新增 `af_plan_restore`、`af_storage`、`af_plan_list`。
- 恢复计划复用同一执行器：隔离副本变源、原路径变目标，原路径被占用则跳过。

## 0.3.0

- 新增 `af_plan_execute`：逐项复核 `dev+ino+size+mtime+SHA-256`，独占创建、fsync、回读校验后才删源。
- schema v4：`plan_ops` 与 `execution_log`；崩溃后 `executing` 转为 `needs-review`，绝不自动续跑。

## 0.2.x

- 0.2.2：确认卡正文改为纯文本排版（宿主不渲染 Markdown）。
- 0.2.1：卡片预览行改为关键数字。
- 0.2.0：不可变计划 + digest；`ctx.userQuestions` 的 plan-review 授权；单次 CAS 状态迁移。

## 0.1.x

- 0.1.5：遮蔽模式下分卷家族名替换为短 hash，修隐私泄漏。
- 0.1.4：命名歧义标记收敛；新增分卷/未完成下载保护（schema v2）。
- 0.1.3：新增 `af_probe_write`（写入语义探测）。
- 0.1.0：只读索引：扫描、分类、内容去重、编号识别、APK 结构检查。
