# @laoyinbai/dsh-tool-android-files

面向 **Android 版 DeepSeek Harness（DSH）** 的文件整理插件。当前版本 `0.1.5`，处于 **M1：只读分析**，外加 M2 的写入能力探测。

M1 能做的事：把指定目录**索引**到手机本地 SQLite，做分类、内容级去重、自动编号文件名识别、APK 结构检查，
然后以**聚合数字**的形式向模型汇报。**不会移动、重命名、删除任何用户文件。**

唯一的写操作是 `af_probe_write`：它只在插件自己的数据目录（以及你显式配置的 `probeDir`）里建几个临时文件，
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
  https://github.com/LaoYinBai/dsh-tool-android-files/releases/download/v0.1.5/laoyinbai-dsh-tool-android-files-0.1.5.tgz
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
| `enableWrite` | — | M2 保留位。本版本忽略并给出提示。 |

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
npm pack             # 产物：laoyinbai-dsh-tool-android-files-0.1.5.tgz
```

仓库内 `lib/` 即发布物，提交前请确认 `node --check` 与 `node --test` 均通过。
`tools/smoke/` 下有一套用**真实 DSH 编译器**做端到端冒烟的方法，见该目录 README。

## 9. 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 索引扫描、分类、内容去重、编号名识别、SQLite 持久化、隐私裁剪 | **本次交付** |
| M2 | 不可变计划 + digest、`userQuestions` plan-review 授权、建目录/复制/移动/改名、状态机、中断核对 | **进行中**：写入语义探测（`af_probe_write`）已交付 |
| M3 | 重复副本隔离、恢复方案、空间统计（仍不开放永久清空） | 未开始 |
| M4 | 独立测试目录里的异常场景验收、性能与取消验证 | 未开始 |

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

## 11. 许可

未声明许可证，保留所有权利。
