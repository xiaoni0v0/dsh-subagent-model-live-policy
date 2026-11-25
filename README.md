# dsh-subagent-model-live-policy

让 subagent 的模型白名单实时生效。

## 设置改了，旧会话不认

DSH 在创建 Agent 时把子模型白名单记成一条会话事件
（`subagent/model-selection-policy`），投影只认第一条。所以设置页改了白名单，
只有之后新建的会话能拿到。界面显示新列表，`subagent(provider, model)` 还在拒绝
新加的、还在接受删掉的。

再追加一条事件没有用。投影状态只能是「非空路由数组」或 `null`，会话格式校验
又不接受空的 `allowedModels`，所以「列表变空」写不进去。

改成覆盖读取路径。`subagent` 和 `list_subagent_models` 都通过
`ProjectionHandle.stateOf(session)` 读白名单，它内部是：

```js
stateOf: session => this.cellFor(registration, session).state
```

`cellFor` 是投影注册表原型上的方法。按投影 key 过滤后包一层，两个消费者每次调用
都读到实时配置。会话日志、投影 fold、格式校验都不用动。

关掉开关时返回 `null`，也就是 DSH 自己「没有记录策略」的状态，它会自动把显式
选择限制为父会话路由。

## 它不做什么

不写会话事件，不改会话日志，不注册工具，不加系统提示词，不改任何工具的描述。

白名单直接读现有的 `subagentModelSelection` 服务，不留副本，设置页始终是唯一
来源。

如果 DSH 改了 `cellFor` 的名字，插件会发现对不上，在日志里说明原因，然后什么都
不做。

## 补丁怎么保证不出乱子

补丁做了引用计数。HMR 时新 fiber 先挂载、旧 fiber 后卸载，会有两个实例并存；
各自持一个引用，最后一个释放时才恢复原方法。

没有计数的话，第一次卸载就把补丁剥掉了，活着的实例还以为自己装好了，实时读取
会静默失效，直到下次重启。

## 还有什么限制

关掉开关只是停止授予新授权，不会擦掉旧会话日志里已经写下的列表。那些会话回落到
父路由，也就是 DSH 自己「无策略」的含义。

开关开着但白名单是空的，等于什么都不授予。

## 安装

```sh
dsh plugin --profile desktop add github:xiaoni0v0/dsh-subagent-model-live-policy
```

装完重载或重启 DSH。

## 测试

用的是当前安装里真实的 `SessionProjectionRegistry`，覆盖的就是工具真正走的那条
读路径。共 22 项。

```sh
ELECTRON_RUN_AS_NODE=1 "<DSH 可执行文件>" test.mjs
```

## 许可证

MIT
