---
name: 战斗技能Spine检查工具
overview: 开发一个独立 HTML 工具页面，通过读取本地配置 JSON 文件 + 调用内网 Spine 接口，自动检查多段技能的 Spine 动画 hit_end 事件帧数量是否与配置相符。
todos:
  - id: t1
    content: 搭建 HTML 工具框架：复用 Spine 预览页样式，实现本地 JSON 文件拖拽加载（skill_data1-6 + effect_show_data + skill_effect_data）和配置解析
    status: completed
  - id: t2
    content: 实现技能扫描逻辑：全量扫描 + 指定ID过滤，以 effect_list.length >= 2 为多段判定，完成两路查表并提取每个技能的 Spine 资源ID、动作名、群攻标志
    status: completed
  - id: t3
    content: 实现 Spine skel 文件加载与 hit_end 事件解析：通过内网接口下载 skel，使用 spine-webgl.js 解析所有动作的 EventTimeline，统计指定动作的 hit_end 数量
    status: completed
  - id: t4
    content: 实现检查与结果展示：对比期望 hit_end 数量与实际数量，渲染结果表格（Pass/Fail/Skip），支持导出报告
    status: completed
isProject: false
---

# 战斗技能 Spine hit_end 配置检查工具

## 当前产物

- 工具文件：`spine_check.html`
- 依赖文件：`libs/vue.global.js`、`libs/spine-webgl.js`
- 参考原始预览页：`Spine 动画预览.html`

## 目标

针对所有“多段攻击技能”（当前约定为 `skill_data*.json -> data_get_skill[skillId].effect_list.length >= 2`），自动检查对应 Spine 动作中的 `hit_end` 事件帧数量是否满足配置要求。

当前检查期望值：

```text
expectedHitEnd = effect_list.length - 1
```

## 已锁定业务规则

### 多段判定

- 以 `data_get_skill.effect_list.length >= 2` 作为待检查技能筛选条件。
- 这是工具侧的筛选规则，不等价于战斗最终伤害段数；当前按策划要求用于排查复杂技能配置。

### 是否有表现

必须参考业务代码：

- `assets/scripts/mod/battle/BattleModel.ts:1599-1605`
- `assets/scripts/mod/battle/BattleConfigUtils.ts:135-162`

业务判定关键点：

```ts
let effectConfig = BattleConfigUtils.getBattleEffectShowCfgByEffectBid(effectBid, attacker.useSkin);
const needShowEffect = effectBid && effectConfig && effectConfig.show_id != 0;
```

工具实现要求：

- 不允许只检查 `effect_list[0]`。
- 必须遍历 `effect_list` 内每个 `effectBid`。
- 对每个 `effectBid` 执行与 `getBattleEffectShowCfgByEffectBid` 一致的查表链路。
- 只要任意 `effectBid` 能查到 `show_id != 0` 的 `data_get_show_data`，该技能就认为有表现并纳入检查。
- 如果整个 `effect_list` 都没有表现，则忽略，不进入结果列表。

### 表现查找链路

```text
effectBid
  -> skill_data*.data_get_effect_desc[effectBid].effect_show_id
  -> effect_show_data.data_get_show2_id[effectShowId].show_id
  -> effect_show_data.data_get_show_data[showId]

如果上述新逻辑没有 showId：
  -> effect_show_data.data_get_show_id[effectBid]
  -> effect_show_data.data_get_show_data[showId]
```

判定有表现时，还要满足：

```text
showCfg 存在 && showCfg.show_id != 0
```

### 单体与群攻规则

#### 单体技能

判断：`showCfg.area_effect_list` 为空。

检查资源：

```text
effect_show_data.data_get_show2_id[effectShowId].skill_modle_res
showCfg.anime_user_atk
```

注意：

- 如果 `skill_modle_res` 为空或为 `0`，当前工具无法定位角色模型 Spine，直接忽略该表现项。
- 如果 `anime_user_atk` 为空，显示为 `Skip`，原因：缺少动作名。

#### 群攻技能

判断：`showCfg.area_effect_list` 非空。

检查资源：

```text
showCfg.area_effect_list[]
  -> skill_effect_data.data_get_effect_data[effectId]
  -> res_up + up_action_name
  -> res_down + down_action_name
```

规则：

- `res_up/up_action_name` 非空时生成一个检查项。
- `res_down/down_action_name` 非空时生成一个检查项。
- 缺少 `skill_effect_data` 条目时显示 `Skip`，原因：群攻特效配置缺失。
- 有资源但缺少动作名时显示 `Skip`，原因：群攻特效动作名缺失。

### 去重规则

同一个技能中，如果多个 `effectBid` 映射到同一组：

```text
skillId + 单体/群攻 + spineId + actionName + areaEffectId + areaTag
```

则只保留一个检查项，并把 `effectBid/effectShowId/showId` 合并展示。

## Spine 资源接口

- 文件列表：`GET http://192.168.6.1/spine/?spine_id={ID}`，解析 HTML 中 `const data = {...}` 的 `files` 字段。
- skel 文件：`GET http://192.168.6.1/spine/index.php?spine_id={ID}&spine_file={key}.skel`
- atlas 文件：`GET http://192.168.6.1/spine/index.php?spine_id={ID}&spine_file={key}.atlas`
- png 文件：`GET http://192.168.6.1/spine/index.php?spine_id={ID}&spine_file={key}.png`

如果本地 `file://` 打开遇到跨域限制，需要把 HTML 放到 Spine 服务同源目录，或通过本地静态服务/代理访问。

## Spine 解析逻辑

- 使用 `spine-webgl.js`。
- 通过 `spine.webgl.AssetManager` 加载 `.skel/.atlas/.png`。
- 使用 `spine.SkeletonBinary` 读取 `skeletonData`。
- 遍历 `skeletonData.animations` 找到目标 `actionName`。
- 遍历目标 animation 的 timelines。
- 若 `timeline instanceof spine.EventTimeline`，遍历 `timeline.events`，统计 `event.data.name === "hit_end"` 的数量。

## 当前 UI 功能

### 配置文件加载

支持拖拽/选择本地 JSON：

- `skill_data*.json`
- `effect_show_data.json`
- `skill_effect_data.json`

### 上传文件缓存

已实现文件缓存：

- 上传过的 JSON 保存在页面内存中。
- 同名文件再次上传会覆盖缓存并自动启用。
- 每个文件有 `删除/恢复` 操作。
- 删除不是物理删除，只是不参与检查。
- 恢复后重新参与检查。
- 每次删除/恢复都会通过 `rebuildEnabledConfig()` 重建 `loadedFiles` 索引。

关键函数：

```text
cacheUploadFile(fileName, data)
toggleUploadFile(fileName)
rebuildEnabledConfig()
mergeConfig(fileName, data)
```

### 扫描控制

- 支持全量扫描。
- 支持输入技能 ID 过滤。
- `scanMode = all` 时扫描所有 `effect_list.length >= 2` 的技能。
- `scanMode = filter` 或过滤框非空时，只扫描输入的技能 ID。

### 卡顿优化

已改为分批处理：

- 点击开始后不再一次性构建完整 pending 列表。
- 按候选技能逐个构建检查项。
- 每处理若干条 `await nextFrame()` 让出 UI 线程。
- 进度按候选技能显示：`progressCurrent / progressTotal`。

### 结果展示

结果表字段：

- 状态：Pass / Fail / Skip
- 技能 ID / 技能名 / owner
- 单体或群攻
- `effect_list`
- `effectBid/effectShowId/showId`
- Spine ID / 动作名 / fileKey
- 实际 `hit_end` 数量
- 原因
- 操作
- 详情

### 跳过/失败原因

当前原因包括：

- `hit_end 数量不足`
- `缺少动作名`
- `群攻特效配置缺失`
- `群攻特效动作名缺失`
- `Spine 加载或解析失败`

无表现技能不显示为 Skip，直接忽略。

### 失败项 Spine 预览

失败行显示 `预览` 按钮。

预览弹窗能力：

- 渲染失败项对应 Spine 动画。
- 显示当前动作事件帧列表。
- `hit_end` 事件高亮。
- 显示技能 ID、Spine ID、动作名、期望/实际 `hit_end` 数量。

关键函数：

```text
openPreview(row)
closePreview()
renderPreview()
collectAnimationEvents(animation)
calculateSkeletonBounds(skeleton)
```

## 当前关键函数索引

文件：`g:\临时\战斗技能Spine_hit_end检查工具.html`

```text
readFiles(files)                       上传并解析 JSON
cacheUploadFile(fileName, data)         缓存上传文件
rebuildEnabledConfig()                  根据启用文件重建配置索引
mergeConfig(fileName, data)             按配置类型合并数据
getSkillCandidates()                    生成候选技能
resolveShowConfig(effectBid)            按业务逻辑查表现配置
buildCheckItems(skillId, skill)         遍历 effect_list 生成检查项
buildShowCheckItems(base, show)         单体/群攻分流
buildAreaCheckItems(base, areaList)     群攻特效检查项生成
mergeDuplicateCheckItems(items)         检查项去重
startScan()                             分批扫描入口
checkOneItem(item)                      单个检查项执行
getHitEndCount(spineId, actionName)     获取 hit_end 数量
getSpineFiles(spineId)                  获取资源文件列表
loadSkeletonData(...)                   加载并解析 skel
countAnimationEvent(animation, name)    统计事件帧
openPreview(row)                        失败项预览
exportReport()                          导出 JSON 报告
```

## 已验证事项

- HTML 脚本语法已多次通过 Node `new Function(script)` 校验。
- 修复“只检查 `effect_list[0]` 导致所有配置被认定无表现”的问题。
- 使用当前配置快速统计过：候选技能约 2970，其中能找到表现的技能约 2188。

## 后续可能优化

- 将工具迁移到项目内 `tools/` 或独立工具目录，避免放在 `g:\临时`。
- 增加报告导出 CSV。
- 增加只显示 Fail/Skip 的默认视图。
- 增加对 `partner_show_data` 皮肤表现映射的可选支持，目前工具没有输入 `useSkin`，默认不处理皮肤分支。
