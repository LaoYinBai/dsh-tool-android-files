# @laoyinbai/dsh-tool-android-files

面向 **Android 版 DeepSeek Harness（DSH）** 的文件整理插件。当前版本 `1.0.1`：**M1 只读分析 + M2.1 计划与授权**。

M1 能做的事：把指定目录**索引**到手机本地 SQLite，做分类、内容级去重、自动编号文件名识别、APK 结构检查，
然后以**聚合数字**的形式向模型汇报。**不会移动、重命名、删除任何用户文件。**

M2.1 能做的事：把去重结果固化成**不可变计划**（含 digest），在 UI 里弹出 plan-review 卡片请用户真正点确认，
确认后把计划标成 `approved`。**本版本仍然不移动任何文件**——执行器在下一个版本。

唯一的临时写操作是 `af_probe_write`：它只在插件自己的数据目录（以及你显式配置的 `probeDir`）里建几个临时文件，
测完立刻删除并核对残留。它不碰任何用户文件。

M2 的正式写入能力（不可变计划 + 可信授权 + 隔离区 + 状态机）尚未实现，也没有注册任何移动/改名/删除工具。

---

## 1. 设计取舍（为什么和常见插件不一样）

| 取舍 | 原因 |
|---|---|
| **没有构建步骤**，`lib/` 就是源码（纯 ESM、零运行时依赖） | 手机端不具备构建能力，pnpm 对 git 依赖又禁止 `prepare` 脚本。把源码直接当产物，从根上消除"仓库里 `lib/` 与 `src/` 不一致"这一整类故障。 |
| **不导出 Schemastery `Config`** | 配置非法时若 schema 校验失败，Cordis 会跳过整个插件，工具全部消失。改为在 `apply()` 内手工归一化，非法项降级并写入 `af_backend`，插件仍可加载。 |
| **只读，且默认遮蔽文件名** | 文件清单、完整路径、哈希都属于隐私数据。默认只回传计数与匿名 id；只有显式 `reveal=true` 才返回真实名称。 |
| **所有结论都写进 `render()` 文本** | DSH 只把 `render()` 生成的文本交给模型，`execute()` 返回的 JSON 值**不进模型上下文**（那是给 PTC/UI 用的）。因此每个工具的渲染文本都自带一行 `key=value`，含 `ok=`、`scan_id=`、全部计数与 `error=`，模型不需要“猜”结构化字段。 |
| **不跟随符号链接** | 目录遍历永不进入 symlink，符号链接目录一律跳过并计数。 |
| **移动保留时间戳** | `copyFile` 会把目标的时间刷成"现在"，而归档布局正是按修改月份推导的。复制后把源的 atime/mtime 写回目标；文件系统拒绝时只记 `times-not-preserved` 日志，不阻塞移动。 |
| **不做 `ctx.fs` 调用** | DSH 原生文件服务没有 move/copy/delete，且受沙箱策略影响；本插件统一用 `node:fs/promises`。 |
| **`node:sqlite` 而非 better-sqlite3** | 设备上没有任何原生模块预编译产物，也没有编译器。 |

## 2. 安装（手机端）

插件按 DSH 官方插件格式交付：npm 包 + Cordis 插件 + `dsh.bundle.patch`。

```sh
# 变量
DSHBIN="$HOME/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="$HOME/payload/runtime/bin/node"

# 方式 A：从 GitHub 仓库直接安装（推荐本次使用）
"$NODE" "$DSHBIN" plugin --profile web add git+https://github.com/LaoYinBai/dsh-tool-android-files.git

# 方式 B：GitHub Release 预打包 tgz
"$NODE" "$DSHBIN" plugin --profile web add \
  https://github.com/LaoYinBai/dsh-tool-android-files/releases/download/v0.6.0/laoyinbai-dsh-tool-android-files-0.6.0.tgz
```

> 版本门禁：DSH 在加载前会校验 `peerDependencies` 里 `@deepseek-ai/dsh-*` 与运行时版本是否兼容。
> 本包声明 `@deepseek-ai/dsh-tools: ^0.2.0-rc.2`、`@deepseek-ai/cordis: ^4.0.4`。
> 目标设备为 DSH `0.2.0-rc.2`。若加载行被标成 `disabled: true`，先看 `plugins.log` 的版本拒绝原因。

## 3. 配置

在 profile 的 `cordis.patch.yml` 中追加（或由 `dsh plugin add` 自动生成 `insert` 行后编辑 `config`）：

```yaml
- insert:
    - id: android-files
      name: '@laoyinbai/dsh-tool-android-files'
      config:
        roots:
          - /storage/emulated/0/Download
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `roots` | `[]` | **必填**的绝对路径白名单。为空时所有工具都拒绝执行并说明原因。 |
| `dataDir` | `$DSH_HOME/plugin-data/dsh-tool-android-files` | 索引库与插件数据目录。 |
| `maxEntries` | `5000` | 单次扫描索引条目上限，达到后标记 `truncated`。上限 `200000`。 |
| `includeSubdirs` | `true` | 是否递归子目录。 |
| `excludeNames` | `[]` | 精确跳过的文件名。 |
| `excludeExts` | `[]` | 跳过的扩展名（不含点）。 |
| `excludePatterns` | `[]` | 只支持 `*` 的简单通配。 |
| `rules` | `[]` | 追加在內建规则之后的分类规则，见下。 |
| `probeDir` | '' | `af_probe_write` 在共享存储上做写入探测的目录。必须绝对路径且已存在；只有位于已配置根目录内（或 Android 上位于 `/storage/emulated/0/DeepSeekHarness` 内）才会被采用。 |
| `quarantineDir` | `''` | **生成计划所必需**。隔离区根目录，必须是绝对路径。建议放在共享存储（与用户文件同卷）：`/storage/emulated/0/DeepSeekHarness/quarantine`。未配置时 `af_plan_create` 直接拒绝。 |
| `enableWrite` | — | 执行器开关，M2.2 起生效。本版本忽略并给出提示。 |

规则对象可用的条件（**全部满足**才算命中，按数组顺序首条命中生效）：

```yaml
rules:
  - id: camera-raw
    category: image            # image|video|audio|document|archive|installer|other
    exts: [dng, cr3]
    keywords: [img_]           # 名称包含
    minSize: 1048576           # 字节
    maxSize: 209715200
    dirIncludes: [dcim]        # 相对目录包含
```

> 命中不同类别的两条规则时，记录 `conflict` 并标记待确认，**不会**自动移动（M2 生效）。

## 4. 工具

| 工具 | 副作用 | 说明 |
|---|---|---|
| `af_backend` | 仅插件目录 | 报告版本、平台、Node/SQLite 版本、索引库位置与可写性、配置的根目录当前是否可打开、能力清单。 |
| `af_probe_write` | **会写临时文件** | 在插件数据目录与已配置的 `probeDir` 内测 `O_EXCL`/独占复制/硬链接/rename 是否覆盖/跨目录 rename/fsync/时间戳精度/剩余空间，测完自清理并报告残留。不碰用户文件。 |
| `af_scan` | 仅索引库 | 扫描已配置根目录（或其中一个），入库并计算候选哈希。只读用户文件。 |
| `af_scan_report` | 无 | 单次扫描的聚合报告：分类计数、重复统计、零字节、冲突、错误。**不含路径**。 |
| `af_files` | 无 | 分页浏览索引条目。**默认遮蔽名称与路径**；分卷家族名替换为 `family=#<hash8>` 短令牌。 |
| `af_duplicates` | 无 | 按 `大小 + SHA-256` 输出重复组，并单列 `protected_groups` / `protected_bytes`。**默认遮蔽成员名**。 |
| `af_names` | 无 | 自动编号文件名发现：`(1)`/`（1）` 位置、规范名候选、APK 结构检查结果、冲突/待确认标记。 |
| `af_plan_create` | 仅计划表 | 为一次扫描生成**不可变去重计划**：每组保留一份，其余移入隔离区。受保护的组整组跳过并计入 `skipped_groups/skipped_bytes`。返回 `plan_id + digest`。 |
| `af_plan_preview` | 无 | 分页预览计划里的每一条操作（源、隔离目标、大小、原因），默认遮蔽路径。 |
| `af_plan_apply` | 计划状态 | **只接受 `plan_id`**；重算并核对 digest 后，调 `ctx.userQuestions` 弹 plan-review 卡片；只有用户点 Approve 才把计划置为 `approved`（单次、CAS）。**不移动文件**，返回 `executed=0`。 |
| `af_plan_execute` | **会移动文件** | 执行已 `approved` 的计划：逐项复核 `dev+ino+size+mtime+sha256` → 独占创建目标 → `fsync` → 回读校验 → 删除源 → `fsync` 目录。目标已存在或源已变化则**跳过该项并保留源**。每步落 journal。 |
| `af_plan_list` | 无 | 列出计划 id / 模式 / 状态 / 操作数 / digest 前缀。指向旧扫描的 `proposed`/`approved` 计划标为 `stale`。 |
| `af_storage` | 无 | 隔离区占用（按计划目录统计文件数与字节）与所在卷空间。**明确说明隔离不构成空间回收**。 |
| `af_plan_archive` | 仅计划表 | 生成**归档计划**（`mode=archive`）：把扫描根目录**顶层**的文件按 `类别/年-月/` 归入子目录。子目录里的文件不动，保护文件跳过，目标已存在则在扩展名前取空闲编号，**绝不覆盖**。 |
| `af_plan_restore` | 仅计划表 | 为已提交计划生成**恢复计划**（`mode=restore`）：把隔离文件搬回原路径。原路径被占用则跳过、绝不覆盖；搬回前重新哈希隔离副本。生成后同样要 `af_plan_apply` + `af_plan_execute`。 |

工具名使用 `af_` 前缀并保持裸标识符形式（`^[a-z][a-z0-9_]*$`），兼容 PTC 代码模式。

## 5. 隐私边界

- 文件**内容**从不离开设备；只有工具返回值会进入模型上下文。
- 索引（名称、路径、大小、哈希、关系）只存在手机本地 SQLite。
- 默认返回值只含计数、分类与匿名 id。`af_files` / `af_duplicates` 的 `reveal` 默认 `false`；
  设为 `true` 表示**文件名与相对路径会随工具结果发送给云端模型**，只应在用户明确要求查看时使用。
- 分卷家族名（`protection` 里的 `family=`）在遮蔽模式下替换为 8 位短 hash：既能跨行分组，又不泄露真实基名。
- 错误信息只含错误码、路径相对形式与系统 errno，不含文件内容、不含任何凭据。

## 6. 安全边界

- 根目录必须显式配置且为绝对路径；工具传入的 `root` 必须是已配置根目录的子路径，
  且其 `realpath` 仍落在该根目录的 `realpath` 之内（防止树内符号链接把范围放大）。
- 永久拒绝：`/storage/emulated/0/Android/data`、`Android/obb`、`/data`、`/proc`、`/sys`、`/system`、`/vendor`、`/apex`、`/dev`。
  含性判断使用 `path.relative`，**不使用字符串前缀**。
- 遍历不跟随符号链接；每次下降前重新 `lstat` 目录，发现已变成链接或非目录即跳过。
- 扫描开始与结束各校验一次根目录 `dev+ino`，被替换则整次扫描失败（`AF_ROOT_CHANGED`）。
- 同一时刻只允许一个扫描；取消通过 `exec.signal` 传递，文件之间与哈希分块之间都会检查。

## 7. 已知限制（诚实清单）

- **未在真机验证**：本版本在开发机（Windows + Node 24）用**真实的 DSH `defineTool` 编译器**跑通了注册与全流程冒烟，
  每个工具返回值都按各自的编译后输出 schema 校验过，并跑了 44 个单元测试；
  但 Android 设备上的加载、SQLite 落盘、FUSE 路径行为尚未实测。
- **没有 MIME 类型**：Node 不提供 MIME 探测，分类只看扩展名。`af_backend` 会明确说明这一点。
- **没有进度事件**：普通工具没有调用中进度，只有开始/结束。大目录请配合 `maxEntries` 与取消。
- **扫描是同步工具**：未使用 `ctx.jobs`。超长扫描会占用该次工具调用；中断后重新扫描会重建索引（哈希有缓存）。
- **零字节文件不参与去重**，只单独计数。
- **未做 5GB 大文件与万级目录的性能验证**（M1 未要求，属 M4 验收项）。
- **不使用 `ctx.approval`**：当前 `danger-full-access` 预设下它恒返回 `rejected`；M2 的授权走 `ctx.userQuestions` 的 plan-review。

## 8. 开发

```sh
node --test          # 44 个单元测试（不需要任何依赖）
npm run check        # 全部 lib 文件语法检查
npm pack             # 产物：laoyinbai-dsh-tool-android-files-0.6.0.tgz
```

仓库内 `lib/` 即发布物，提交前请确认 `node --check` 与 `node --test` 均通过。
`tools/smoke/` 下有一套用**真实 DSH 编译器**做端到端冒烟的方法，见该目录 README。

## 9. 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 索引扫描、分类、内容去重、编号名识别、SQLite 持久化、隐私裁剪 | 完成 |
| M2 | 不可变计划 + digest、`userQuestions` plan-review 授权、独占复制 + 校验 + 删源、状态机、journal、重启核对 | **完成（0.3.0）** |
| M3 | 恢复方案、空间统计、隔离区浏览（仍不开放永久清空） | **完成（0.4.0）**：`af_plan_restore` + `af_storage` + `af_plan_list`；永久清空依旧不提供 |
| M4 | 计划生命周期（`source_plan_id` / `restored`）、方向正确的文案、空目录清理、故障注入与性能 | **完成（0.6.x）**：真机故障注入与性能验收通过 |
| M5 | 按类别 + 月份归档（`af_plan_archive`） | **本次交付（0.7.0）** |

## 10. 真机实测的写入语义（M2 设计依据）

`af_probe_write` 在 Xiaomi `24031PN0DC` / Android 16 上实测（FUSE 共享存储 + ext4 应用卷）：

| 能力 | 应用私有卷 (dev 65078) | 共享存储 (dev 1048595) | 结论 |
|---|---|---|---|
| `O_EXCL` 独占创建 | ✅ | ✅ | 不覆盖创建有可靠底座 |
| `COPYFILE_EXCL` 独占复制 | ✅ | ✅ | 复制落盘可保证不覆盖 |
| `link()` 硬链接 | ❌ EACCES | ❌ EACCES | `link`→`unlink` 方案出局 |
| `rename` 静默覆盖目标 | ⚠️ 是 | ⚠️ 是 | **裸 `rename` 不能当移动用** |
| 跨目录 `rename` | ✅ inode 稳定 | ✅ inode 稳定 | 同卷移动可用但不安全 |
| `fsync` 文件 / 目录 | ✅ / ✅ | ✅ / ✅ | 可承诺"内容已校验 + 目录项已提交" |
| 时间戳分辨率 | 4 ms | **8 ms**（`mtimeNs` 可用） | 并发核对以 `dev+ino+size+mtimeNs` 为必要条件，非充分条件 |
| `statfs` 可用空间 | 370.4 GiB | 370.4 GiB | 空间预检可行 |

**由此确定的移动策略**

1. 同卷移动 = `copyFile(COPYFILE_EXCL)` → `fsync(file)` → SHA-256 校验 → `unlink(源)`。
2. 目标已存在 → 直接 fail-closed，绝不覆盖。
3. 跨卷（应用卷 ↔ 共享存储）必须 copy→verify→delete，并预检剩余空间。
4. 隔离区应放**共享存储**（与用户文件同卷），否则每次隔离都是一次跨卷复制。
5. 裸 `rename` 只在"目标确认不存在 + 同卷 + 单文件"时作为优化，失败立即回退 copy 方案。
6. 任一前提不成立 → `AF_UNSUPPORTED`，不降级。

**永不自动处理的文件**（真机数据里真实存在这些）

| 类型 | 判据 | 处理 |
|---|---|---|
| 未完成下载 | `.part` `.downloading` `.crdownload` `.tmp` `.aria2` | 只索引，永不移动/隔离/改名 |
| 数据库旁路 | `.db-journal` `.db-wal` `.db-shm` `.lock` | 只索引，永不移动 |
| 分卷成员 | `.1` `.001` `.002` `.z01` `.r00`（按家族保护） | 整组保护，绝不单独去重 |

实测案例：一个 80.9 MB × 4 的重复组，四个成员扩展名都是 `.1` —— 若按普通重复文件处理，会破坏一个分卷集合。

### 授权卡片（v0.2.0 真机实测）

| 现象 | 说明 |
|---|---|
| 标题显示「计划待审」，按钮显示「要求修改 / 同意执行」 | Web UI 用 `intent.kind='plan-review'` 套了自己的**本地化模板**，会替换插件传入的 header 与选项文案 |
| 但 `af_plan_apply` 拿到的是 `authorized=true` | **回传给插件的仍是你传入的 approve label**，UI 只翻译显示、不改回传值——判定逻辑必须基于 canonical label，不能基于界面文字 |
| 折叠态标题/摘要由客户端的 `extractMarkdownPlainText` 取**第一行/第一段** | 所以第 1 行是标题、第 2 行必须是关键数字（`26 项操作 · 移动 203 MiB · 跳过 1 组受保护（243 MiB）`） |
| 「查看全文」打开的是侧栏文档；本机实测该面板**按原文显示**，不解析 Markdown | 所以正文改成无 Markdown 语法的纯文本排版（分隔线 + 缩进块 + 千分位），在原文显示和 GFM 渲染两种情况下都读得下去；digest 仍在正文里，需要展开才能看到 |

实测对账：`skipped_bytes(254,407,380) + planned_bytes(213,372,998) = 467,780,378`，与 `af_duplicates` 的 `wasted_bytes` 总额完全相等——保护跳过与可执行量之间没有漏算。

## 11. 许可

`UNLICENSED` —— 保留所有权利，不授予复用许可。如需开源，请自行添加 LICENSE 并修改 `package.json` 的 `license` 字段。

## 12. 验收手册（真机）

### A. 计划生命周期回归

`af_plan_list` 应显示恢复计划与前向计划的互指：

```
5  restore committed ... undoes=#3
4  restore committed ... undoes=#2
3  dedupe  restored  ... restored_by=#5
2  dedupe  restored  ... restored_by=#4
1  dedupe  approved  ... stale=true
```

历史计划（0.4.0 写入、无 `source_plan_id`）由 v5 迁移从隔离路径反推补齐。

### B. 故障注入

| # | 场景 | 造法 | 期望 |
|---|---|---|---|
| B1 | 目标已存在 | 计划生成后，在 `quarantine/<planId>/` 下手建同名目标 | 该项 `failed`，源保留，计划 `needs-review` |
| B2 | 源被执行前改动 | 计划生成后 `echo x >> 源文件` | 该项 `failed`（hash 不符），源保留 |
| B3 | 执行中被杀 | `af_plan_execute` 期间 `kill -9 <engine pid>` | 重启后计划 `needs-review`，`plan_ops` 停在 `copying`/`committed`，**不自动续跑** |
| B4 | 空间不足 | 纯函数 `spaceVerdict` 已单测覆盖；真机不造 ENOSPC | 拒绝启动（`AF_UNSUPPORTED`），一个字节都不写 |

> B3 之后不要重试旧计划：重新 `af_scan` 再生成新计划。旧计划停留在 `needs-review` 作为证据。

### C. 性能

```sh
NODE="$HOME/payload/runtime/bin/node"
BENCH=/storage/emulated/0/DeepSeekHarness/af-bench
# 1 万个空文件
"$NODE" -e "const fs=require('fs');fs.mkdirSync('$BENCH',{recursive:true});for(let i=0;i<10000;i++)fs.writeFileSync('$BENCH/f'+i+'.txt','')"
# 两个 512 MiB 同尺寸文件（触发流式哈希）
"$NODE" -e "const fs=require('fs');const b=Buffer.alloc(1048576);for(const n of ['a.bin','b.bin']){const fd=fs.openSync('$BENCH/'+n,'w');for(let i=0;i<512;i++)fs.writeSync(fd,b);fs.closeSync(fd)}"
```

把 `$BENCH` 加进 `roots`，然后：

```
af_scan root=$BENCH maxEntries=20000
```

记录 `files / dirs / elapsed_ms / hashed / peak_rss_mb`。

判据：

- 1 万文件扫描应在 **30 秒内**完成（按 8.8 ms/文件外推约 90 秒，是上限）
- `peak_rss_mb` 不应随文件数线性增长；扫描 1 万个空文件与 600 个真实文件的峰值应在同一量级
- 512 MiB × 2 的哈希：`hashed=2`，`peak_rss_mb` **不应增加约 512 MB**——若增加说明某处把文件读进了内存

5 GB 单文件未实测：用同一套方法把 `count` 增大即可，判据相同。

### D. 清理

清理是**人为动作**，插件永远不会做。不要用 `rm -rf`：它会静默接受错误路径，也不校验目标身份。
先确认目录就是自己建的那一个，再只删它：

```sh
B=/storage/emulated/0/DeepSeekHarness/af-bench
# 三道校验：存在、是目录、不是符号链接且 realpath 与字面路径完全一致
test -d "$B" && test ! -L "$B" && test "$(realpath "$B")" = "$B" && ls -la "$B"
```

看清 `ls` 输出里只有 `many/`、`pair/`、`dup/` 三个子目录后，用文件管理器删掉 `af-bench`，
或者对**这个已确认的字面路径**执行 `rm -r -- "$B"`（不带 `-f`，路径不加通配）。

判据：如果 `realpath` 与字面路径不一致（例如被替换成符号链接），**什么都不要删**，先查清楚。
