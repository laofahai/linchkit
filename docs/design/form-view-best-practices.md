# 企业级表单视图布局设计参考

> 基于 Odoo 17/18、Salesforce Lightning、ERPNext、Linear 等产品的设计模式分析。
> 目标：为 LinchKit AutoForm 组件提供可直接落地的布局规范。

---

## 一、各产品表单布局对比

### 1. Odoo 17/18 Form View

**整体结构**（从上到下）：
```
┌─ ControlPanel ──────────────────────────────────┐
│ [← 面包屑]              [操作按钮] [状态条▸▸▸] │
├─────────────────────────────────────────────────┤
│ ░░ 灰色背景 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ░░ ┌─── Sheet（白色卡片）──────────────────┐ ░░ │
│ ░░ │ [头像]  记录名称（大字）              │ ░░ │
│ ░░ │         副标题字段                     │ ░░ │
│ ░░ │─────────────────────────────────────│ ░░ │
│ ░░ │ ┌─ group ──┐  ┌─ group ──┐         │ ░░ │
│ ░░ │ │ 标签: 值  │  │ 标签: 值  │         │ ░░ │
│ ░░ │ │ 标签: 值  │  │ 标签: 值  │         │ ░░ │
│ ░░ │ └──────────┘  └──────────┘         │ ░░ │
│ ░░ │─────────────────────────────────────│ ░░ │
│ ░░ │ [Tab1] [Tab2] [Tab3]               │ ░░ │
│ ░░ │ ┌─ tab content ──────────────────┐ │ ░░ │
│ ░░ │ │ 明细行表格 / 更多字段分组       │ │ ░░ │
│ ░░ │ └────────────────────────────────┘ │ ░░ │
│ ░░ └───────────────────────────────────┘ ░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└─────────────────────────────────────────────────┘
```

**关键设计点**：
- **Sheet 模式**：表单内容放在一个白色卡片内，外围是 `#f0f0f0` 灰色背景，形成视觉层次
- **状态条**：位于顶部右侧，使用 chevron 箭头连接的步骤条（当前已实现）
- **操作按钮**：位于状态条左边，同在顶部 ControlPanel 中
- **字段布局**：标签右对齐、固定宽度（约 150px），值左对齐，行高一致
- **两列分组**：`<group>` 默认两列，嵌套 `<group>` 可实现四列
- **Notebook**：Tab 切换，底部下划线指示当前 tab
- **编辑模式**：整体表单在 view/edit 之间切换，非单字段 inline edit

### 2. Salesforce Lightning Record Page

**整体结构**：
```
┌─ Record Header ─────────────────────────────────┐
│ [← 返回]  图标  记录名称                        │
│ [关键字段摘要: 状态 | 金额 | 日期]              │
│ ─────────────────────────────────────────────── │
│ [编辑] [删除] [克隆] [▼ 更多操作]               │
├─────────────────────────────────────────────────┤
│ ┌─ Detail Section ──────────────────────────┐   │
│ │ ▾ 基本信息                                 │   │
│ │ ┌────────────┐  ┌────────────┐            │   │
│ │ │ 标签       │  │ 标签       │            │   │
│ │ │ 值         │  │ 值         │            │   │
│ │ └────────────┘  └────────────┘            │   │
│ │ ▾ 附加信息                                 │   │
│ │ ┌────────────┐  ┌────────────┐            │   │
│ │ │ ...        │  │ ...        │            │   │
│ │ └────────────┘  └────────────┘            │   │
│ └────────────────────────────────────────────┘   │
│ ┌─ Related Lists ───────────────────────────┐   │
│ │ 关联记录列表                               │   │
│ └────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**关键设计点**：
- **Compact Layout**：记录头部展示 4-5 个关键字段（Highlights Panel）
- **标签在值上方**（stacked layout），非左对齐
- **可折叠 Section**：每个 section 有标题和折叠三角
- **操作按钮**：位于记录头部下方，主操作 + 下拉更多
- **Inline Edit**：单击字段值即可编辑，铅笔图标提示，非全局 edit mode
- **状态指示**：Path 组件（类似 Odoo 的进度条）或 Badge

### 3. ERPNext (Frappe Framework)

**整体结构**：与 Odoo 非常相似：
```
┌─ Page Header ───────────────────────────────────┐
│ [面包屑: 模块 > 列表 > 记录]                    │
│ 记录名称              [菜单▼] [操作按钮] [状态] │
├─────────────────────────────────────────────────┤
│ ┌─ Form Body ────────────────────────────────┐  │
│ │ Section Break: 基本信息                     │  │
│ │ ┌─ Column ─┐  ┌─ Column ─┐                │  │
│ │ │ 标签: 值  │  │ 标签: 值  │                │  │
│ │ └──────────┘  └──────────┘                │  │
│ │ Section Break: 明细                        │  │
│ │ [子表格]                                    │  │
│ │ Section Break: 备注                        │  │
│ │ [富文本编辑器]                              │  │
│ └────────────────────────────────────────────┘  │
│ ┌─ Comment/Timeline ────────────────────────┐  │
│ │ 操作日志 / 评论                            │  │
│ └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**关键设计点**：
- **无 Sheet 卡片**：表单直接平铺在页面上，通过 Section Break 分隔
- **标签在值上方**（top-aligned labels），非右对齐
- **状态指示**：右上角的彩色 Badge（Draft=红色, Submitted=蓝色, Cancelled=灰色）
- **操作按钮**：主操作在顶部右侧，如 Submit / Amend / Cancel
- **自动保存**：修改即自动保存，无 edit/view mode 切换
- **Section Break + Column Break**：用分隔符控制布局

### 4. Linear / Notion（现代 SaaS）

**整体结构**：
```
┌─ Sidebar ─┬─ Main Content ──────────────────────┐
│            │ [← 返回]  [操作图标按钮]            │
│ 导航       │ ──────────────────────────────────  │
│            │ 标题（可编辑的大号文本）             │
│            │                                     │
│            │ ┌─ Properties Panel ──────────────┐ │
│            │ │ 状态      [●] In Progress       │ │
│            │ │ 优先级    [⚑] High              │ │
│            │ │ 负责人    [👤] John              │ │
│            │ │ 标签      [tag1] [tag2]          │ │
│            │ └────────────────────────────────┘ │
│            │                                     │
│            │ 描述区域（Markdown/富文本）          │
│            │                                     │
│            │ ┌─ Activity ─────────────────────┐ │
│            │ │ 评论 / 活动日志                  │ │
│            │ └────────────────────────────────┘ │
└────────────┴─────────────────────────────────────┘
```

**关键设计点**：
- **无传统表单**：属性面板用键值对行展示，标签左对齐、值右侧
- **Inline Edit 一切**：点击任意值即可编辑，无全局 edit mode
- **状态切换**：下拉菜单或点击切换，非步骤条
- **极简操作栏**：图标按钮（复制链接、删除、更多），无文字
- **全宽标题**：标题单独一行，直接可编辑

---

## 二、设计决策建议

### 1. 操作按钮定位

| 产品 | 位置 | 方式 |
|------|------|------|
| Odoo | 顶部控制面板，状态条左侧 | 文字按钮 |
| Salesforce | 记录头下方 | 主按钮 + 下拉更多 |
| ERPNext | 顶部右侧 | 文字按钮 + 菜单 |
| Linear | 顶部右侧 | 图标按钮 |

**建议**：采用 Odoo 模式。操作按钮放在**页面顶部右侧**，与状态条同行。
理由：对于业务记录（采购单、发票），操作按钮（审批/拒绝/提交）必须醒目且不需要滚动。

```
推荐布局：
[← 返回] 记录标题          [审批] [拒绝] [StatusBar▸▸▸] [编辑]
```

### 2. 状态指示器

| 产品 | 样式 |
|------|------|
| Odoo | Chevron 步骤条（箭头连接） |
| Salesforce | Path（步骤条）或 Badge |
| ERPNext | 彩色 Badge |
| Linear | 彩色圆点 + 文字 |

**建议**：保留当前的 **Chevron StatusBar**（已实现），适合业务流程场景。
对于简单状态（如 active/archived），降级为 **Badge** 显示。

### 3. 字段布局

| 产品 | 标签位置 | 对齐方式 |
|------|----------|----------|
| Odoo | 左侧，右对齐 | label: 固定宽度右对齐，value: 左对齐 |
| Salesforce | 值上方 | stacked，标签小灰字 |
| ERPNext | 值上方 | stacked，标签小灰字 |
| Linear | 左侧，左对齐 | 键值对行 |

**建议**：采用 **Odoo 风格的左侧右对齐标签**（当前已实现）。
理由：对于字段密集的业务表单，左对齐标签+值的水平排列信息密度更高。

**具体参数**：
- Label 宽度：`w-[150px]`（当前 `w-28` = 112px，建议加宽）
- Label 对齐：`text-right`
- 行高：`min-h-[36px]`，所有字段行等高
- 两列间距：`gap-x-8`（32px）
- 必填字段背景：淡蓝色 `bg-blue-50/50` 或左边框 `border-l-2 border-blue-400`

### 4. Sheet（卡片）模式

| 产品 | 是否有 Sheet |
|------|-------------|
| Odoo | 有，白色卡片 + 灰色背景 |
| Salesforce | 有，Card 组件包裹 |
| ERPNext | 无，直接平铺 |
| Linear | 无，全宽内容 |

**建议**：采用 **Sheet 模式**。表单内容包裹在白色卡片中。

```css
/* 外层容器 */
.form-page-bg {
  @apply bg-muted/50 min-h-screen p-6;
}

/* Sheet 卡片 */
.form-sheet {
  @apply bg-background rounded-lg shadow-sm border border-border/50;
  @apply mx-auto max-w-5xl px-10 py-8;
}
```

### 5. View/Edit 模式切换

| 产品 | 方式 |
|------|------|
| Odoo | 全局 Edit 按钮，切换整个表单 |
| Salesforce | 字段级 inline edit（单击铅笔） |
| ERPNext | 自动保存，无模式切换 |
| Linear | 字段级 inline edit |

**建议**：采用 **Odoo 模式的全局切换**（当前已实现），理由：
- 业务表单通常有验证规则和联动逻辑，全局提交更安全
- 简化状态管理
- 未来可考虑增加字段级 inline edit 作为增强

### 6. 表单头部结构

**推荐布局**：
```
┌──────────────────────────────────────────────────┐
│ [←] Schema名称 > 记录名称     [操作] [状态▸▸▸]  │
│                                [Edit] / [Save Cancel] │
├──────────────────────────────────────────────────┤
│ ┌─ Sheet ──────────────────────────────────────┐ │
│ │ ...                                          │ │
```

层级结构：
1. **返回按钮**：`←` ghost button
2. **面包屑**：`Schema Label` > `Record Name`（小字 + 大字）
3. **操作按钮区**（右侧）：业务操作 → 状态条 → 编辑按钮

---

## 三、AutoForm 组件改进建议

### 推荐的 DOM 结构

```tsx
{/* 页面级：灰色背景 */}
<div className="bg-muted/50 min-h-[calc(100vh-var(--header-h))]">

  {/* 顶部控制面板：固定在内容顶部 */}
  <div className="sticky top-0 z-10 bg-background border-b px-6 py-3">
    <div className="flex items-center justify-between max-w-5xl mx-auto">
      {/* 左：返回 + 标题 */}
      <div className="flex items-center gap-2">
        <BackButton />
        <Breadcrumb schema={schema} record={record} />
      </div>
      {/* 右：操作 + 状态 + 编辑 */}
      <div className="flex items-center gap-3">
        <ActionButtons />
        <StatusBar />
        <EditToggle />
      </div>
    </div>
  </div>

  {/* Sheet 卡片 */}
  <div className="max-w-5xl mx-auto my-6 px-6">
    <div className="bg-background rounded-lg shadow-sm border p-8">
      <AutoForm ... />
    </div>
  </div>
</div>
```

### CSS/Tailwind 布局要点

```css
/* 字段行 */
.field-row {
  @apply flex items-center gap-x-3 py-2
         border-b border-border/20 last:border-b-0;
  min-height: 36px;
}

/* 标签 - Odoo 风格右对齐 */
.field-label {
  @apply w-[150px] shrink-0 text-right
         text-sm text-muted-foreground
         leading-9 truncate;
}

/* 值 */
.field-value {
  @apply flex-1 min-w-0 text-sm leading-9;
}

/* 分组容器 - 两列 */
.field-group {
  @apply grid grid-cols-2 gap-x-8;
}

/* 分组标题 */
.group-title {
  @apply col-span-full py-3
         text-xs font-semibold uppercase tracking-wider
         text-muted-foreground
         border-b border-border/50;
}

/* Notebook Tabs */
.notebook-tabs {
  @apply flex gap-1 border-b border-border;
}
.notebook-tab {
  @apply px-4 py-2.5 text-sm font-medium
         text-muted-foreground
         hover:text-foreground
         transition-colors;
}
.notebook-tab--active {
  @apply text-foreground
         border-b-2 border-primary
         -mb-px;  /* 覆盖父边框 */
}

/* Sheet 卡片 */
.form-sheet {
  @apply bg-background rounded-lg
         shadow-sm border border-border/50
         max-w-5xl mx-auto
         px-10 py-8;
}

/* 必填字段强调 */
.field-row--required {
  @apply bg-blue-50/30 dark:bg-blue-950/10;
}

/* 编辑模式下的输入框 */
.field-input {
  @apply h-9 border-0 border-b border-transparent
         bg-transparent
         focus:border-primary focus:ring-0
         rounded-none;
  /* Odoo 风格：无边框，仅底部下划线 */
}

/* View 模式下的值 */
.field-display {
  @apply text-foreground leading-9;
}
```

### 响应式断点

```css
/* 移动端：单列，标签在上方 */
@media (max-width: 768px) {
  .field-row {
    @apply flex-col items-start gap-0;
  }
  .field-label {
    @apply w-full text-left text-xs;
  }
  .field-group {
    @apply grid-cols-1;
  }
  .form-sheet {
    @apply px-4 py-4 rounded-none shadow-none border-0;
  }
}
```

---

## 四、实施优先级

| 优先级 | 改进项 | 说明 |
|--------|--------|------|
| P0 | Sheet 卡片包裹 | 页面加灰色背景，表单套白色卡片 |
| P0 | 顶部控制面板 sticky | 操作按钮始终可见 |
| P0 | 标签宽度调整 | `w-28` → `w-[150px]` |
| P1 | 输入框样式 Odoo 化 | 无边框、底部下划线 |
| P1 | 必填字段视觉提示 | 浅色背景色 |
| P1 | 响应式单列适配 | 移动端标签在上方 |
| P2 | Notebook tab 样式优化 | 底部边框指示器 |
| P2 | 字段 dirty 标记优化 | 左边框蓝色条代替圆点 |

---

## 五、总结

LinchKit 的 AutoForm 已经走在正确的方向上（Odoo 风格标签布局、StatusBar、Group/Notebook）。
主要需要补充的是**页面级别的容器结构**（Sheet 卡片 + 灰色背景 + sticky 控制面板），
以及**细节打磨**（标签宽度、输入框无边框样式、响应式适配）。

核心原则：**业务表单看 Odoo，现代 SaaS 看 Linear，取两者之长**。
