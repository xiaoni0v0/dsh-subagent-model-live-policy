# dsh-subagent-model-live-policy

让 subagent 的模型白名单实时生效，并让派发工具学会先查清单。

解决两个独立的问题，一个很小的插件。

## 一、设置改了只对新会话生效

DSH 在创建 Agent 时把子模型白名单记成一条会话事件（`subagent/model-selection-policy`），而它的投影只认**第一条**。所以设置页改了白名单，只有之后新建的会话能拿到：界面显示的是新列表，`subagent(provider, model)` 却还在拒绝新加的、还在接受删掉的。

再追加事件修不了。投影状态只能是「非空路由数组」或 `null`，而会话格式校验又不接受空的 `allowedModels`，所以「列表变空」这件事根本写不进去。

这个插件改成覆盖**唯一的读取路径**。`subagent` 和 `list_subagent_models` 都是通过 `ProjectionHandle.stateOf(session)` 读白名单的，而它内部就是：

```js
stateOf: session => this.cellFor(registration, session).state
```

`cellFor` 是投影注册表原型上的方法。按投影 key 过滤后包一层，两个消费者每次调用都会读到实时配置；会话日志、投影 fold、格式校验全都不动。

**关掉开关**返回 `null`，这正是 DSH 自己「没有记录策略」的状态，它会自动把显式选择限制为父会话路由——插件不发明新语义。

## 二、派发工具不知道路由 id

`subagent` 的 `provider` 和 `model` 是自由字符串。模型猜一个看起来合理的 id（比如 profile 里注册的是 `codex`，它猜成 `openai`），只有调用被拒之后才知道错。

`tools.schemas()` 每次调用都会重新投影所有工具定义，所以包一层只在 `subagent` 和 `subagent_fork` 的描述后追加一句提示：

> 传 `provider` 或 `model` 之前，先调 `list_subagent_models`……并从它的回复里复制精确 id。这些 id 是随 profile 变的：provider 未必按厂商命名，所以别从模型名去推。

提示里不写任何具体 provider 名，所以换掉订阅插件也依然有效。

## 它不做什么

- 不写会话事件，不改会话日志。
- 不注册工具。
- 不加系统提示词。
- 白名单直接读现有的 `subagentModelSelection` 服务，不留副本，设置页始终是唯一事实来源。
- 如果 DSH 改了 `cellFor` 或 `schemas` 的名字，插件会检测到不匹配、在日志里说明原因，然后什么都不做。

## 补丁如何保证安全

两个补丁都做了引用计数。HMR 时新 fiber 先挂载、旧 fiber 后卸载，两个实例会短暂并存；各自持有一个引用，**最后一个释放时才恢复原方法**。

如果没有计数，第一次卸载就会剥掉补丁，而存活的实例仍以为自己装好了——实时读取会静默失效，直到下次重启。

两个补丁由同一个 effect 管理，卸载时按相反顺序释放，不会留下半打过补丁的原型。

## 仍然存在的限制

- **关掉开关**只是停止授予新授权，不会擦掉旧会话日志里已经写下的列表。那些会话会回落到父路由，也就是 DSH 自己「无策略」的含义。
- 开关开着但白名单为空，等于什么都不授予。

## 安装

```sh
dsh plugin --profile desktop add github:xiaoni0v0/dsh-subagent-model-live-policy
```

装完重载或重启 DSH 生效。

## 测试

测试用的是当前安装里真实的 `SessionProjectionRegistry`，所以覆盖的就是工具真正走的那条读路径。共 34 项。

```sh
ELECTRON_RUN_AS_NODE=1 "<DSH 可执行文件>" test.mjs
```

## 许可证

MIT
