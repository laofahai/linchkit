# 企业级列表视图布局设计参考

> 基于 Odoo 17/18、Salesforce Lightning、ERPNext、shadcn/ui Data Table、TanStack Table 的设计模式分析。
> 目标：为 LinchKit AutoList 组件提供可直接落地的布局规范。

---

## 一、各产品列表视图对比

### 1. Odoo 17/18 List View

**整体结构**：
```
┌─ ControlPanel ──────────────────────────────────────┐
│ [面包屑]   [搜索栏🔍 + Facet Tags]    [新建] [操作▼] │
│            [分组▼] [收藏▼] [筛选▼]                   │
├─────────────────────────────────────────────────────┤
│ [☐] 列标题A ▲  │ 列标题B    │ 列标题C   │ 金额合计  │
│ ─────────────────────────────────────────────────── │
│ [☐] 值          │ 值         │ Badge     │ ¥1,200   │
│ [☐] 值          │ 值         │ Badge     │ ¥3,400   │
│ [☐] 值          │ 值         │ Badge     │ ¥800     │
├─────────────────────────────────────────────────────┤
│                              合计:       │ ¥5,400   │
│ ◀ 1-80 / 235 ▶                                     │
└─────────────────────────────────────────────────────┘
```

**关键设计点**：
- **ControlPanel**：搜索栏居中，两端放按钮。搜索栏内嵌 Facet Tag（如 `状态: 已确认 ×`）
- **SearchPanel**：可展开的左侧筛选面板（Category + Filter），默认收起
- **行选择**：左侧 checkbox，选中后顶部出现操作栏（删除、导出、批量操作）
- **列排序**：点击列标题切换升/降序，箭头图标指示
- **列合计**：数值列底部自动汇总
- **分页**：`1-80 / 235` 格式，上/下页箭头，无页码跳转

### 2. Salesforce Lightning List View

**整体结构**：
```
┌─ List Header ───────────────────────────────────────┐
│ 列表名称 ▼   [PIN📌] [筛选图标] [图表]   [新建]     │
│ 项目数: 50+          视图切换: [列表|看板]           │
├──────────┬──────────────────────────────────────────┤
│ Filters  │ [☐] 名称 ▲    │ 阶段      │ 金额       │
│ Panel    │ ────────────────────────────────────── │
│ (可收起)  │ [☐] Deal A    │ Proposal  │ $50,000    │
│          │ [☐] Deal B    │ Closed    │ $120,000   │
│ 状态      │                                        │
│ ☐ 开放    │                                        │
│ ☐ 关闭    │                                        │
│          │                                        │
│ 金额范围  │                                        │
│ [__]-[__]│                                        │
├──────────┴──────────────────────────────────────────┤
│ ◀ 1-50 of 235 ▶                [显示 25|50|100 条]  │
└─────────────────────────────────────────────────────┘
```

**关键设计点**：
- **筛选面板**：左侧可收起的 Filters Panel，字段类型自动匹配筛选器
- **批量操作**：选中行后顶部出现 action bar（编辑、删除、更改所有者等）
- **列表视图切换**：顶部下拉选择不同预设视图（My Open、All、Recently Viewed）
- **Inline Edit**：双击单元格直接编辑
- **分页**：显示总数 + 每页条数选择器

### 3. ERPNext (Frappe) List View

**整体结构**：
```
┌─ Page Header ───────────────────────────────────────┐
│ DocType名称         [筛选栏: 字段=值 ×]    [+ 新建]  │
│ [编辑字段▼] [排序▼] [每页条数▼]                      │
├─────────────────────────────────────────────────────┤
│ [☐] [状态●] 标题              修改日期    状态Badge  │
│ [☐] [状态●] 标题              修改日期    状态Badge  │
│ [☐] [状态●] 标题              修改日期    状态Badge  │
├─────────────────────────────────────────────────────┤
│ 显示 1 到 20 共 58 条    [加载更多]                   │
└─────────────────────────────────────────────────────┘
```

**关键设计点**：
- **筛选器即标签**：顶部输入型筛选器，`字段 = 值` 以 Tag 形式展示，可叠加多个
- **左侧状态指示**：彩色圆点标记行状态（蓝=已提交、红=草稿、灰=已取消）
- **无传统表头**：列表更像卡片行，标题突出、辅助信息小字
- **分页**：「加载更多」按钮，非传统翻页
- **批量操作**：选中后底部浮出操作栏（删除、打印、导出）

### 4. shadcn/ui Data Table

**整体结构**：
```
┌─ Toolbar ───────────────────────────────────────────┐
│ [🔍 Filter emails...]              [⚙ Columns ▼]   │
├─────────────────────────────────────────────────────┤
│ [☐] │ 状态 ▲  │ 邮箱          │ 金额      │ [⋯]   │
│ ─────────────────────────────────────────────────── │
│ [☐] │ Success │ ken@y.com     │ $316.00   │ [⋯]   │
│ [☐] │ Pending │ abe@x.com     │ $242.00   │ [⋯]   │
├─────────────────────────────────────────────────────┤
│ 2 of 100 row(s) selected    ◀ Page 1 of 10 ▶       │
└─────────────────────────────────────────────────────┘
```

**关键设计点**：
- **Toolbar**：搜索框左、列可见性切换右，用 `flex items-center py-4` 布局
- **表格容器**：`overflow-hidden rounded-md border` 圆角边框
- **列头**：可排序列用 Button ghost + 箭头图标，含下拉菜单（排序/隐藏列）
- **行操作**：每行最右侧 `⋯` 下拉菜单（DropdownMenu）
- **选中反馈**：底部左侧 `X of Y row(s) selected`
- **分页**：底部 Previous/Next + 页码显示 + 每页条数选择

### 5. TanStack Table 核心模式

**设计理念**：Headless UI，不提供样式，只提供状态管理。

**核心能力**：
- **列定义**：`ColumnDef` 声明式定义 `accessorKey` / `header` / `cell`
- **排序**：`getSortedRowModel()` + `column.toggleSorting()`
- **筛选**：`getFilteredRowModel()` + `columnFilters` state，支持 Faceted Filter
- **分页**：`getPaginationRowModel()` + page size / page index state
- **行选择**：`getIsSelected()` / `toggleSelected()` / `toggleAllRowsSelected()`
- **列调整**：`enableResizing` + `column.getSize()` / `onColumnSizingChange`
- **列可见性**：`columnVisibility` state + `column.toggleVisibility()`

---

## 二、设计决策建议

### 1. 页面整体布局

**推荐方案（Odoo + shadcn 融合）**：
```
┌─ ControlPanel (sticky) ────────────────────────────┐
│ [←] 模型名称               [搜索栏🔍 + Facets]      │
│                     [筛选▼] [分组▼] [新建] [操作▼]   │
├─────────────────────────────────────────────────────┤
│ ┌─ Table Card ─────────────────────────────────┐    │
│ │ [☐]│ 列A ▲  │ 列B     │ 列C Badge │ 金额   │    │
│ │ [☐]│ ...    │ ...     │ ...       │ ...    │    │
│ │────────────────────────────────────────────│    │
│ │ X 条已选中 [批量操作▼]     ◀ 1/10 页 ▶      │    │
│ └───────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 2. 筛选器集成方式

| 方案 | 适用场景 | 代表产品 |
|------|----------|----------|
| 顶部搜索栏 + Facet Tag | 通用，快速筛选 | Odoo, ERPNext |
| 左侧筛选面板 | 字段多、需多维筛选 | Salesforce |
| 顶部 Faceted Filter 按钮 | 中等复杂度 | shadcn, Linear |

**建议**：默认使用 **顶部 Faceted Filter** 模式（shadcn 风格），可选启用侧边筛选面板。
搜索栏内嵌 Facet Tag 展示已激活筛选条件。

### 3. 行选择 + 批量操作

**推荐模式**：
- 首列 checkbox，表头 checkbox 控制全选
- 选中后：表格底部状态栏变为操作栏，显示已选数量 + 批量操作按钮
- 批量操作：删除、导出、状态变更等，通过 `DropdownMenu` 展开

### 4. 分页模式

| 模式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 页码翻页 | 可跳转，可预知总量 | 需要 count 查询 | 业务数据（默认） |
| 加载更多 | 简单，移动端友好 | 无法跳转 | 日志、活动流 |
| 无限滚动 | 体验流畅 | 内存占用，定位困难 | Feed 类数据 |

**建议**：默认 **页码翻页**，支持每页条数切换（20/50/100）。

### 5. 列头样式

**推荐**：
- 可排序列：`Button variant="ghost"` + 排序箭头图标
- 文本列左对齐，数值列右对齐
- 列宽支持拖拽调整（TanStack Table `enableResizing`）
- 列可见性：Toolbar 右侧 Columns 下拉控制

---

## 三、Tailwind CSS 布局规范

```css
/* ControlPanel - 顶部控制栏 */
.list-control-panel {
  @apply sticky top-0 z-10 bg-background border-b px-6 py-3;
}
.list-control-panel-inner {
  @apply flex items-center justify-between gap-4;
}

/* 搜索栏 */
.list-search {
  @apply flex-1 max-w-md;
}
.list-search input {
  @apply h-9 w-full rounded-md border bg-transparent px-3
         text-sm placeholder:text-muted-foreground
         focus:outline-none focus:ring-1 focus:ring-ring;
}

/* Facet Tag */
.facet-tag {
  @apply inline-flex items-center gap-1
         rounded-md border px-2 py-0.5
         text-xs font-medium bg-muted/50;
}

/* 表格容器 */
.list-table-wrapper {
  @apply overflow-hidden rounded-md border bg-background;
}

/* 表头 */
.list-th {
  @apply h-10 px-3 text-left text-xs font-medium
         text-muted-foreground uppercase tracking-wider
         bg-muted/30 border-b select-none;
}
.list-th--sortable {
  @apply cursor-pointer hover:bg-muted/50 transition-colors;
}
.list-th--numeric {
  @apply text-right;
}

/* 表格行 */
.list-tr {
  @apply border-b transition-colors
         hover:bg-muted/30
         data-[state=selected]:bg-accent;
}

/* 单元格 */
.list-td {
  @apply h-12 px-3 text-sm align-middle;
}
.list-td--numeric {
  @apply text-right tabular-nums;
}

/* 行操作按钮 */
.list-row-actions {
  @apply flex items-center justify-end;
}
.list-row-actions button {
  @apply h-8 w-8 p-0 text-muted-foreground
         hover:text-foreground;
}

/* 底部工具栏 */
.list-footer {
  @apply flex items-center justify-between px-3 py-3
         text-sm text-muted-foreground border-t;
}

/* 批量操作栏（选中行时替换 footer） */
.list-bulk-bar {
  @apply flex items-center gap-3 px-3 py-2
         bg-accent/50 border-t text-sm;
}

/* 分页 */
.list-pagination {
  @apply flex items-center gap-2;
}
.list-pagination button {
  @apply h-8 w-8 rounded-md border
         hover:bg-accent disabled:opacity-50;
}

/* 每页条数选择 */
.list-page-size {
  @apply flex items-center gap-2 text-sm;
}

/* Faceted Filter 弹出面板 */
.filter-popover {
  @apply w-[200px] p-0;
}
.filter-option {
  @apply flex items-center gap-2 px-2 py-1.5
         text-sm cursor-pointer
         hover:bg-accent rounded-sm;
}
```

---

## 四、推荐组件 DOM 结构

```tsx
<div className="space-y-4">
  {/* ControlPanel */}
  <div className="flex items-center justify-between gap-4">
    <div className="flex items-center gap-2">
      <h1 className="text-xl font-semibold">{title}</h1>
    </div>
    <div className="flex items-center gap-2">
      <SearchInput />
      <FacetedFilter column="status" options={statusOptions} />
      <FacetedFilter column="priority" options={priorityOptions} />
      <ColumnVisibilityToggle />
      <Button><Plus /> 新建</Button>
    </div>
  </div>

  {/* Table */}
  <div className="overflow-hidden rounded-md border">
    <Table>
      <TableHeader>...</TableHeader>
      <TableBody>...</TableBody>
    </Table>
  </div>

  {/* Footer */}
  <div className="flex items-center justify-between text-sm">
    <div>{selectedCount > 0 ? `已选 ${selectedCount} 条` : `共 ${total} 条`}</div>
    <div className="flex items-center gap-4">
      <PageSizeSelector />
      <Pagination />
    </div>
  </div>
</div>
```

---

## 五、实施优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 基础表格渲染 | TanStack Table + shadcn Table 组件 |
| P0 | 列排序 | 点击表头切换排序 |
| P0 | 行选择 + 批量操作 | Checkbox 列 + 操作栏 |
| P0 | 分页 | 页码 + 每页条数 |
| P1 | Faceted Filter | 按字段枚举值筛选 |
| P1 | 全局搜索 | 顶部搜索框模糊匹配 |
| P1 | 列可见性 | 下拉勾选控制显隐 |
| P2 | 列拖拽调整宽度 | TanStack columnResizing |
| P2 | 列合计行 | 数值列底部汇总 |
| P2 | 侧边筛选面板 | 复杂筛选场景可选启用 |

---

## 六、总结

核心原则：**列表看 Odoo 的 ControlPanel 布局 + shadcn 的组件实现 + TanStack Table 的状态管理**。

- 搜索和筛选放顶部，Facet Tag 展示已激活条件
- 表格用 `rounded-md border` 卡片包裹，表头 `bg-muted/30` 区分
- 行选择用 checkbox，选中后底部变批量操作栏
- 默认页码分页，支持每页条数切换
- 列排序/可见性/调整宽度均由 TanStack Table headless 管理，UI 层用 shadcn 渲染
