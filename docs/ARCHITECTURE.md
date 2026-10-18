# 架构与安全不变量

给未来维护者的最短说明。所有结论都有代码或真机证据支撑，推测处会明确标注。

## 分层

```
lib/index.js        Cordis 插件入口：装配 state，注册工具
lib/tools.js        14 个模型可见工具；参数校验、隐私裁剪、渲染
lib/plan.js         不可变计划：策略、操作、确定性序列化、digest、卡片正文
lib/confirm.js      唯一的用户授权通道（ctx.userQuestions）
lib/execute.js      唯一会碰用户文件的代码
lib/db.js           SQLite schema、迁移、语句、状态迁移（CAS）
lib/scan.js         迭代遍历、不跟随符号链接、排除规则
lib/naming.js       编号识别；只在结构性改变时给规范名
lib/protect.js      分卷/未完成下载/数据库旁路文件保护 + 遮蔽
lib/apks.js         受限 ZIP 结构检查（不解压）
lib/hash.js         流式 SHA-256
lib/paths.js        realpath 包含性、deny 清单、dev+ino 身份
lib/classify.js     有序规则、冲突记录
lib/config.js       手工归一化（不导出 Schemastery Config）
lib/version.js      从 package.json 读版本
```

## 计划生命周期

```
proposed ──apply(用户点 Approve, CAS+digest)──> approved
    │                                              │
    │ 用户拒绝                                       execute(CAS)
    v                                              v
 rejected(lost)                              executing
                                                   │
                          ┌────────────────────────┼───────────────────┐
                          v                        v                   v
                     committed              needs-review           (崩溃)
                  （全部成功）        （有失败或被取消）               │
                                                            重启时自动转 needs-review
                                                   │
                                             restore 计划成功后
                                                   v
                                               restored
```

`restore` 是独立计划（`mode=restore`），通过 `source_plan_id` 指向前向计划；
恢复成功后前向计划被标 `restored`，且该迁移是单次的。

## 不变量（改动前先读）

1. **源文件只在目标被回读校验后才删除。** 顺序固定：复核身份 → 复制（`COPYFILE_EXCL`）→ 写回时间戳 →
   fsync → 回读哈希 → fsync 目录 → 再查源 → unlink → fsync 源目录。
2. **绝不覆盖。** 目标存在即该项失败；命名冲突在计划阶段解决（取空闲编号）。
3. **不用 `rename` 做移动。** 真机实测两卷 `rename` 都会静默覆盖目标；`link` 两卷都是 EACCES。
4. **崩溃不自动续跑。** `executing` 在重启时变 `needs-review`，`plan_ops` 保留每项状态供人工核对。
5. **授权不可伪造。** `af_plan_apply` 只接受 `plan_id`；批准来自 `ctx.userQuestions` 的返回值，
   且必须是唯一选中项等于插件传入的 canonical label（UI 会本地化显示，但回传原值）。
6. **计划不可变。** `ops_json` 与 `digest` 写后不改；任何改动都会产生新计划与新 digest。
7. **隐私默认关闭。** 名称/路径默认遮蔽；分卷家族名以短 hash 代替。
8. **保护文件永不自动处理。** `.part`/`.downloading`/分卷成员/`.db-journal`。
9. **所有删除都是 `rmdir`（空目录才成功）。** 插件没有递归删除能力。

## 失败语义

| 情况 | 结果 |
|---|---|
| 目标已存在 | 该项 `failed`，源保留 |
| 源在执行前变化 | 该项 `failed`（大小/mtime/ino/哈希任一不符），源保留 |
| 复制后哈希不符 | 删除我们建的副本，源保留 |
| 复制中源被改 | 目标保留、源保留，计划转 `needs-review` |
| 取消 | 不启动新项，当前项收尾 |
| 进程被杀 | 重启后 `needs-review`，不续跑 |
| 空间不足 | 执行前拒绝启动（`AF_UNSUPPORTED`） |

## 已知未验证

- **`committed` 崩溃窗口**（目标已校验、源未删）未在真机撞到；行为正确是推理结论。
- **5 GB 单文件**流式哈希未实测，只有 512 MiB 证据。
- 归档/重命名的恢复路径已由单测覆盖，但真机只验过 dedupe 的恢复。

## 为什么没有 `ctx.jobs`

长任务目前是一次阻塞调用。要做进度，需要宿主的 job 契约（后台句柄、进度读取、生命周期回收）；
在没有契约的情况下实现等于给模型一个错误的接口承诺，所以留到契约明确之后。
