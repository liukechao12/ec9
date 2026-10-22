# EC9 后端接口清单（管理后台对接用）

> 状态：**后端已开发完成并通过回归**，UI 由我们自行设计。
> 本文档是给前端/UI 对接用的接口契约，按「模块」组织，不含任何页面样式信息。
>
> 最后更新：2026-10-14　｜　自检结果：后台接口 86/86、核心 27/27、支付单测 20/20、支付全链路 22/22

---

## 0. 基础约定

| 项 | 值 |
|---|---|
| 本机地址 | `http://localhost:7098` |
| 后台登录页 | `http://localhost:7098/`（EC8 登录页，UI 待替换） |
| API 前缀 | `/api` |
| 字符编码 | 全部 UTF-8（响应头带 `charset=utf-8`） |
| 鉴权方式 | JWT。除标注「公开」的接口外，全部需要请求头 `Authorization: Bearer <token>` |
| 登录接口 | `POST /api/admin/login`，返回 `{ code:200, data:{ token, ... } }` |

### 统一响应结构

成功：
```json
{ "code": 0, "message": "ok", "data": { } }
```

失败：
```json
{ "code": 400, "message": "错误原因（可直接展示给用户）" }
```

> ⚠️ 历史原因：EC8 迁移过来的接口成功时返回 `code: 200`，EC9 新增接口返回 `code: 0`。
> **前端判断成功请用 `code === 0 || code === 200`**，不要只判一个。

失败 HTTP 状态码约定：`400` 参数/业务错误、`401` 未登录、`403` 权限不足、`404` 不存在、`500` 服务端异常。

### 角色

| role | 说明 |
|---|---|
| `admin` | 管理员，可做删除、批量操作、库存调整、退款 |
| `bd` | 业务 BD，多数操作只读 + 自己范围内的数据 |

标注「admin」的接口需 `role === 'admin'`，BD 调用返回 403。

---

## 1. 登录与账号

### `POST /api/admin/login` — 公开
```json
{ "username": "admin", "password": "admin123" }
```
返回 `{ code:200, data:{ token, user:{ id, username, name, role } } }`

### 其他
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/me` | 登录 | 当前用户信息 |
| PUT | `/api/admin/change-password` | 登录 | 改密码 `{ old_password, new_password }` |
| GET | `/api/admins` | 登录 | 账号列表，支持 `page/pageSize/role/status/keyword` |
| GET | `/api/admins/list/bd` | 登录 | BD 下拉选项（不分页） |
| POST | `/api/admins` | admin | 新建账号 |
| PUT | `/api/admins/:id` | admin | 更新账号 |
| DELETE | `/api/admins/:id` | admin | 删除账号 |
| POST | `/api/admins/import` | admin | 批量导入 |

内置账号：`admin/admin123`、`bd001/bd001123`、`bd002/bd002123`、`bd003/bd003123`

---

## 2. 会议 / 场次 / 票种 EC9 新增核心模块）

### 2.1 会议 `/api/events`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/events` | 登录 | 列表 `page/pageSize/status` |
| GET | `/api/events/:id` | 登录 | 详情（返回原始多语字段，供编辑） |
| POST | `/api/events` | 登录 | 创建 |
| PUT | `/api/events/:id` | 登录 | 更新 |
| DELETE | `/api/events/:id` | 登录 | 删除 |
| GET | `/api/events/:id/statistics` | 登录 | 单会议统计 |
| POST | `/api/events/translate` | 登录 | 自动翻译 `{ text, targets:['zh-TW','en'] }` |
| GET | `/api/events/translate/status` | 登录 | 翻译任务状态 |

会议字段：`name` `description` `cover_image` `location` `address` `start_time` `end_time` `signup_start_time` `signup_end_time` `status` `audit_mode`(`manual`/`auto`) `pay_expire_hours` `extra_fields`

### 2.2 场次 `/api/sessions`（EC9 新增）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/sessions` | 登录 | 列表 `event_id/page/pageSize/keyword/status` |
| GET | `/api/sessions/:id` | 登录 | 详情，含该场次的票种列表 |
| POST | `/api/sessions` | 登录 | 新建 |
| PUT | `/api/sessions/:id` | 登录 | 更新 |
| DELETE | `/api/sessions/:id` | 登录 | 删除（已售票或被票种引用时自动改为停用） |
| POST | `/api/sessions/:id/status` | 登录 | 启用/停用 `{ status: 0\|1 }` |
| POST | `/api/sessions/reorder` | admin | 批量排序 `{ items:[{id,sort}] }` |

创建/更新字段：
```json
{
  "event_id": 1,
  "name": "上午主会场",
  "i18n": { "name": { "en": "Morning Session" }, "location": { "en": "Hall A" } },
  "start_time": "2026-12-01T09:00:00.000Z",
  "end_time":   "2026-12-01T12:00:00.000Z",
  "location": "北京国家会议中心",
  "stock_total": 500,
  "status": 1, "sort": 0
}
```
> 多语写法：简体写 `name`，译文写 `i18n.name.{en,zh-TW}`。存库时简体会自动并入 `i18n.name.zh-CN`。
> 详情返回多两个计算字段：`stock_used`（已售+已锁定）、`stock_remaining`。

### 2.3 票种 `/api/ticket-types`（EC9 新增）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/ticket-types` | 登录 | 列表 `event_id/session_id/on_shelf/status/keyword` |
| GET | `/api/ticket-types/:id` | 登录 | 详情，含售卖统计 |
| POST | `/api/ticket-types` | 登录 | 新建 |
| PUT | `/api/ticket-types/:id` | 登录 | 更新（含价格、库存） |
| DELETE | `/api/ticket-types/:id` | 登录 | 删除（有占用时拒绝） |
| POST | `/api/ticket-types/:id/shelf` | 登录 | 上/下架 `{ on_shelf: 0\|1 }` |
| POST | `/api/ticket-types/:id/stock` | admin | 追加库存 `{ delta: 10 }` 或 `{ delta: -5 }` |
| POST | `/api/ticket-types/reorder` | admin | 批量排序 |

创建/更新字段：
```json
{
  "event_id": 1,
  "session_id": 0,
  "name": "早鸟票",
  "i18n": { "name": { "en": "Early Bird" }, "description": { "en": "Limited" } },
  "description": "限时优惠",
  "price": 399,
  "original_price": 599,
  "stock_total": 100,
  "per_order_limit": 2,
  "on_shelf": 1,
  "sort": 0
}
```

**库存三层模型（UI 要按这个显示进度条）**
```
stock_total    总量
stock_locked   已下单未支付占用
stock_sold     已支付售出
可售 = total - locked - sold     ← 后端已在列表/详情返回 stock_available
```

**已做的服务端校验（前端不必重复，但错误提示可直接展示）**
- 名称不能为空
- 售价 ≥ 0；**原价不能低于售价**
- 库存不能为负；**不能低于 `locked + sold`**
- 每单限购 ≥ 1
- `session_id` 必须存在
- 上架时可售库存必须 > 0

列表额外返回 `session_name`（`session_id=0` 时为「全部场次」）和 `stock_available`。
详情额外返回 `sales: { paid_orders, pending_orders, paid_revenue }`。

---

## 3. 订单管理 `/api/orders`（EC9 新增）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/orders` | 登录 | 列表 |
| GET | `/api/orders/summary` | 登录 | 状态汇总 + 实收 |
| GET | `/api/orders/export` | 登录 | 导出 CSV（带 BOM，Excel 直接打开） |
| GET | `/api/orders/:id` | 登录 | 详情 |
| PUT | `/api/orders/:id/remark` | 登录 | 加备注 |
| POST | `/api/orders/:id/close` | 登录 | 手动关单（释放锁定库存） |
| POST | `/api/orders/:id/refresh` | 登录 | 向微信查单并同步本地状态 |
| POST | `/api/orders/batch-close` | admin | 批量关单 `{ ids:[], reason }` |

列表查询参数：`event_id` `status` `ticket_type_id` `session_id` `guest_id` `keyword`(订单号) `start` `end` `expired=1` `page` `pageSize`

响应：
```json
{
  "code": 0,
  "data": {
    "list": [ { "id":1, "order_no":"EC9...", "status":"paid", "final_amount":"399.00",
                "quantity":1, "expire_at":"...", "paid_at":"...",
                "guest_info": { "name":"张三", "company":"某公司",
                                "phone_masked":"138****5678", "bd_id":"bd001" } } ],
    "total": 10, "page": 1, "pageSize": 20,
    "summary": { "paid_revenue": 3990 }
  }
}
```
> ⚠️ 列表里手机号**只给脱敏值**（`phone_masked`），要给明文需调详情接口 `GET /api/orders/:id`（返回 `guest.phone_plain`）。

### 订单状态机
```
pending_payment（待付款） ──支付成功──> paid（已支付） ──退款──> refunded（已退款）
        └──超时/手动关单──> closed（已关闭）
```
| 状态 | 中文 | 可做的操作 |
|---|---|---|
| `pending_payment` | 待付款 | 发起支付、关单、查单刷新 |
| `paid` | 已支付 | 退款 |
| `closed` | 已关闭 | 无（库存已释放） |
| `refunded` | 已退款 | 无 |

`GET /api/orders/summary` 返回：
```json
{ "pending_payment":{"count":2,"amount":798},
  "paid":{"count":5,"amount":1995},
  "closed":{"count":1,"amount":399},
  "refunded":{"count":0,"amount":0},
  "total_count":8, "paid_revenue":1995 }
```

---

## 4. 支付 `/api/payment`（H5 交易链路）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/payment/native` | 手机号凭证 | 发起支付，返回二维码 |
| POST | `/api/payment/notify` | 微信回调 | 服务端验签（**前端不要调用**） |
| GET | `/api/payment/query/:orderNo` | 手机号凭证 | 轮询订单状态 |
| POST | `/api/payment/refund` | admin | 退款 `{ order_no, reason }` |
| POST | `/api/payment/mock-pay/:orderNo` | 手机号凭证 | 模拟付款，仅 `WXPAY_MODE=mock` 时可用 |

**手机号凭证获取流程**
```
POST /api/verification/send-code   { phone }        → 发验证码
POST /api/verification/verify-code { phone, code }  → 返回 verification_token
后续提交/支付请求带 header: X-Verification-Token: <token>
```

`POST /api/payment/native` 响应：
```json
{ "code":0, "data":{
  "order_no":"EC9...", "amount":399, "code_url":"weixin://...",
  "qr_image":"data:image/png;base64,...", "expire_at":"...", "mock":true } }
```
> `mock: true` 表示当前是 mock 模式，UI 应显示「模拟支付」按钮而非真实扫码。

---

## 5. 支付流水与对账 `/api/payments`（EC9 新增）

只读管理链路，与 `/api/payment` 分工不同。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/payments` | 流水列表，参数 `status/channel/keyword/transaction_id/start/end/event_id/page/pageSize` |
| GET | `/api/payments/summary` | 按状态汇总 + 净收入 |
| GET | `/api/payments/reconcile` | **逐笔对账**，标出差异 |
| GET | `/api/payments/:id` | 单笔详情，含微信原始回调报文 `notify_raw` |

列表响应：
```json
{ "code":0, "data":{
  "list":[ { "id":1, "out_trade_no":"EC9...", "transaction_id":"...", "amount":"399.00",
             "status":"success", "paid_at":"...",
             "order_status":"paid", "quantity":1,
             "guest_name":"张三", "guest_phone_masked":"138****5678" } ],
  "total":10, "page":1, "pageSize":20,
  "summary":{ "success_count":5,"success_amount":1995,
              "refund_count":0,"refund_amount":0,"net_amount":1995 } } }
```

### 对账接口（运营/财务核查用）
`GET /api/payments/reconcile?limit=200`
```json
{ "code":0, "data":{
  "checked":200, "issue_count":2, "error_count":1, "warn_count":1,
  "issues":[
    { "type":"order_paid_no_payment","level":"error",
      "order_no":"EC9...","message":"订单已支付但无成功流水" },
    { "type":"orphan_payment","level":"warn",
      "out_trade_no":"EC9...","message":"流水指向的订单不存在" }
  ] } }
```
差异类型：
| type | level | 含义 |
|---|---|---|
| `order_paid_no_payment` | error | 订单已支付但没有成功流水（钱收了没入账） |
| `payment_success_order_not_paid` | error | 流水成功但订单未标记已支付（回调丢失） |
| `amount_mismatch` | error | 流水金额 ≠ 订单实付金额 |
| `orphan_payment` | warn | 流水指向不存在的订单 |

---

## 5.1 支付配置 `/api/pay-config`（EC9 新增，仅 admin）

微信支付资质**落库 + 后台可改 + 改完热更新**，不再依赖服务器 `.env`（改一次要重启一次）。
DB 无记录时回退 `.env`（老部署方式不受影响）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pay-config` | 当前配置（密钥只回掩码）+ `modes` / `sign_types` 选项 |
| PUT | `/api/pay-config` | 保存配置，保存后**立即生效，无需重启** |
| POST | `/api/pay-config/test` | 配置自检（参数完整性 + 证书可读性，**不发起真实请求**） |
| POST | `/api/pay-config/reload` | 重新从库载入内存 |

字段（PUT 可传）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `mock` 模拟 / `sandbox` 沙箱 / `real` 生产 |
| `enabled` | 0/1 | 渠道启停 |
| `app_id` | string | 公众号或小程序 AppID |
| `mch_id` | string | 商户号 |
| `sub_app_id` / `sub_mch_id` | string | 服务商模式预留 |
| `api_key` | string | API v2 密钥。**留空或回传掩码 = 不修改** |
| `api_v3_key` | string | API v3 密钥（V3 预留） |
| `sign_type` | string | `MD5`（默认）/ `HMAC-SHA256` |
| `cert_path` | string | 退款用 `apiclient_cert.p12` 绝对路径 |
| `notify_url` | string | 支付回调；相对路径自动拼站点域名，生产必须 https |
| `refund_notify_url` | string | 退款回调，可空 |
| `order_expire_minutes` | int | 未支付自动关单分钟数，1~1440 |

安全约定：
- `api_key` / `api_v3_key` **AES 加密落库**，接口只回 `api_key_masked`（首尾各 4 位）+ `api_key_set`
- 生产模式保存前强制校验 appid / 商户号 / 密钥 / 回调地址，缺任一项直接 400
- 全部接口需 `role=admin`，BD 返回 403

自检响应：
```json
{ "code":0, "data":{
  "ok":true, "mode":"mock", "enabled":true, "source":"db",
  "issues":[ { "level":"info", "code":"modeMock",
               "params":[], "message":"当前为模拟模式：…" } ] } }
```
`level`：`error` / `warn` / `info` / `ok`；`code` 供前端按语种取文案（`ec9.payCfg.issue.<code>`），`message` 是中文兜底。

建表与初始化：
```bash
node scripts/init-payment-config.js [--force]   # 建表 + 从 .env 播种（--force 覆盖）
```

---

## 5.2 短信配置 `/api/sms-config`（EC9 新增，仅 admin）

短信通道凭证与验证码参数**同样落库 + 后台可改 + 热更新**，不再依赖 `.env` 里的 `ALIYUN_*` / `SMS_*`。
DB 无记录时回退 `.env`（老部署方式不受影响）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sms-config` | 当前配置（AccessKey Secret 只回掩码）+ `ready` 通道就绪标记 |
| PUT | `/api/sms-config` | 保存，保存后**立即生效，无需重启** |
| POST | `/api/sms-config/test` | 配置自检（不发真实短信） |
| POST | `/api/sms-config/reload` | 重新从库载入内存 |

字段（PUT 可传）：

| 字段 | 说明 |
|---|---|
| `enabled` | 通道启停；停用时不发真实短信，走本地 mock |
| `region` / `endpoint` | 阿里云地域与 endpoint（endpoint 可空） |
| `access_key_id` | AccessKey ID |
| `access_key_secret` | AccessKey Secret。**留空或回传掩码 = 不修改** |
| `sign_name` | 短信签名（需服务商报备通过） |
| `verify_template_code` | 验证码短信模板 CODE |
| `code_expire_minutes` | 验证码有效期，≤60 |
| `code_resend_seconds` | 重发间隔（秒） |
| `code_max_attempts` | 单验证码最大尝试次数 |
| `code_daily_limit` | 单号码每日上限，≤100 |

安全约定：
- 凭证 JSON（accessKeyId/accessKeySecret）**AES 加密**落在 `ec9_sms_providers.config_encrypted`，接口只回 `access_key_secret_masked` + `access_key_secret_set`
- 自检会提示「签名仍是旧主体」等易踩坑项
- 全部接口需 `role=admin`

建表与初始化：
```bash
node scripts/init-sms-config.js [--force]   # 加列 + 从 .env 播种（--force 覆盖）
```

> ⚠️ 已确认：**短信配置此前实际也在 `.env` 里**（`ec9_sms_providers` 表是空的，代码也没读它）。
> 本轮一并与支付配置统一为「库为准、后台可改」。

---


## 5.3 全流程演练暴露的修补（2026-10-14）

跑了一遍「客户真正会走的路」，发现的断点和修补：

| 问题 | 表现 | 处理 |
|---|---|---|
| `GET /api/invitations/pending` | 路由定义在 `/:id` 之后，被详情路由吃掉 → 永远 500 | 详情路由改为 `/:id(\d+)`，静态路径不再被误捕获（9 个路由文件统一处理） |
| `POST /api/orders` | **不存在**，报名通过后无法建单，支付链在接口层是断的 | 新增：admin 或嘉宾本人凭证均可建单（锁库存、校验归属） |
| `GET /api/invitations/code/:code` | `TicketType is not associated to Invitation` → 500 | 改为从报名记录反查票种/场次，附带票价与场次名 |
| `POST /api/registrations/by-phone` | EC8 遗留 `Ticket.create`，而 EC9 的 Ticket 别名指向 TicketType → 500 | EC9 出票统一在支付成功后生成 CheckinCode，此处只登记报名 |
| `ec9_events.page_url` | **列不存在**，业绩说明会报名永远「未找到活动」 | 补列 + 模型字段 + 迁移 `add_event_page_url.sql` |
| `GET /api/guests/export` | 404，嘉宾库导不出 | 新增导出（支持活动/关键词/负责人筛选，导出明文手机号） |
| `statistics/company-statistics` | PG `missing FROM-clause` → 500 | 改手写 SQL |
| `operation-logs/statistics/summary` | `column "id" is ambiguous` / GROUP BY → 500 | 聚合改 `COUNT(*)`，admin 字段并入 GROUP BY |
| `/api/legal/*` | docx 缺失 + 文件名 GBK 乱码 → 500 | 从 EC8 取回并修正文件名编码 |
| 支付凭证一次性 | 下单后轮询就 401「凭证已使用」，H5 走不完 | 新增 `peekToken` + `requireVerifiedReusable`，支付类接口可复用，提交类仍一次性 |
| 开发期收不到验证码 | 短信通道未配时无法联调 | 新增 `POST /api/verification/dev-code`（仅非生产 + mock 通道可用，生产自动 404） |

**仍待外部输入**：
- 嘉宾侧 H5 页面（报名/邀约/签到/业绩说明会）尚未实现 —— 等 10/15、10/18 设计稿
- 短信通道凭证 —— 等 10/19 客户资质

---

## 6. 统计 `/api/statistics`

### EC8 原有
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/statistics/dashboard` | 后台首页概览 |
| GET | `/api/statistics/events/:id/overview` | 单会议概览 |
| GET | `/api/statistics/events/:id/bd-statistics` | 按 BD 统计 |
| GET | `/api/statistics/events/:id/company-statistics` | 按公司统计 |
| GET | `/api/statistics/events/:id/checkin-trend` | 签到趋势 |
| GET | `/api/statistics/events/:id/registration-trend` | 报名趋势 |
| GET | `/api/statistics/daily-registrations` | 每日报名日历 |

### EC9 新增（营收相关）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/statistics/revenue` | 营收总览。参数 `event_id/start/end` |
| GET | `/api/statistics/ticket-sales` | 票种售卖明细。参数 `event_id` |
| GET | `/api/statistics/registration-funnel` | 报名漏斗。参数 `event_id` |

`/revenue` 响应：
```json
{ "code":0, "data":{
  "by_status":{ "paid":{"count":5,"quantity":5,"amount":1995} },
  "paid_orders":5, "paid_quantity":5,
  "paid_revenue":1995, "refunded_orders":0, "refunded_amount":0,
  "net_revenue":1995, "avg_order_value":399,
  "trend":[ { "day":"2026-10-14","count":3,"amount":1197 } ] } }
```

`/ticket-sales` 每项含：`stock_total` `stock_locked` `stock_sold` `stock_available` `paid_orders` `paid_quantity` `revenue` `pending_quantity` `sell_through_rate`(售罄率%)

`/registration-funnel` 四个环节（**适合直接画漏斗图**）：
```json
{ "code":0, "data":{ "total":20, "by_status":{ "approved":12,"paid":8 },
  "steps":[
    { "key":"submitted","label":"提交报名","count":20 },
    { "key":"approved","label":"审核通过","count":12,"rate_of_prev":60 },
    { "key":"paid","label":"已付款","count":8,"rate_of_prev":66.67 },
    { "key":"checkin","label":"已签到","count":0,"rate_of_prev":0 }
  ] } }
```

---

## 7. H5 公开数据 `/api/public`（无需登录）

供 H5 报名页使用，只返回已发布（`status=1`）、已上架（`on_shelf=1`）的数据。
**语言参数**：`?lang=zh-CN|zh-TW|en`，也支持浏览器 `Accept-Language` 头。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/public/events` | 会议列表 |
| GET | `/api/public/events/:id` | 会议详情 + 场次 + 在售票种 |
| GET | `/api/public/events/:id/sessions` | 场次列表 |
| GET | `/api/public/events/:id/tickets` | 在售票种列表 |

详情响应：
```json
{ "code":0, "data":{
  "lang":"en",
  "event": { "id":1, "name":"EC9 Product Launch Event", "description":"...",
             "location":"China National Convention Center", "i18n":{...} },
  "sessions":[ { "id":1, "name":"Morning Session", "location":"...",
                 "start_time":"...", "end_time":"...", "stock_available":480 } ],
  "ticket_types":[ { "id":1, "name":"Early Bird", "description":"...",
                     "price":399, "original_price":599,
                     "per_order_limit":2, "stock_available":97,
                     "session_id":1, "session_name":"Morning Session" } ] } }
```
> 公开接口已按当前语言把 `name`/`description`/`location` 解析好，H5 直接用即可，
> 不需要自己处理多语。完整的 `i18n` 树也在返回里，需要切语言时可自行取用。

---

## 8. 其余 EC8 模块（已完整迁移，字段已适配 PG）

| 模块 | 前缀 | 主要接口 |
|---|---|---|
| 嘉宾 | `/api/guests` | 列表/详情/增删改/导入/修改历史 |
| 邀约 | `/api/invitations` | 列表/详情/批量/审批/拒绝/失效/换会/座位/住宿/导出/待审批/来源BD |
| 报名 | `/api/registrations` | 列表/`submit`/`by-phone`/`submit-by-phone`/`submit-performance` |
| 签到 | `/api/checkins` | 列表/`admin-checkin`/`by-phone`/`event-checkin`/`statistics` |
| 签到码 | `/api/checkin-codes` | 列表/新建/删除/改状态/重生成二维码 |
| 短信 | `/api/sms` | 模板 CRUD/规则 CRUD/发送/自动发送/发送日志 |
| 操作日志 | `/api/operation-logs` | 列表/详情/统计 |
| 法务文档 | `/api/legal` | 用户协议/隐私政策 |
| 验证码 | `/api/verification` | 发码/验码 |

---

## 9. 本轮新修的关键缺陷（供后续排查参考）

后端开发过程中发现并修复了一批从 EC8 迁移时遗留的隐患，都会**静默失败**，值得记录：

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | `phoneEncrypt.js` 用无盐 sha256，`phoneCrypto.js` 用 HMAC，两份重复实现并存 | 走错实现的接口**永远查不到人**，手机号校验/签到/邀约验证全线失效 | 已合并到 `phoneCrypto`，旧文件删除 |
| 2 | 4 处代码直接 `crypto.createHash('sha256')` 算手机号 | 同上 | 已全部改为 `hmacPhone` |
| 3 | `operationLog.js` 写 `description`/`ip_address`，表里是 `detail`/`ip` | **所有后台操作日志只剩一句话**，详情全丢 | 已对齐字段名 |
| 4 | `operationLog.js` 调用了未定义的 `sanitize()` | 敏感信息（密码/手机号）可能明文入日志 | 已实现脱敏 |
| 5 | `checkins.js` 写 `device_info`/`user_agent`/`ip_address`，表里没这三列 | 签到审计信息静默丢失 | 已补列（含远程库 ALTER） |
| 6 | `admin-checkin`/`event-checkin` 没写 `registration_id`/`checkin_code_id`（NOT NULL） | 代签到**整批失败** | 已改为反查报名与签到码 |
| 7 | `i18nData.localize` 对 Sequelize 实例做 `Object.assign` | 公开接口返回被包成 `{dataValues:{...}}`，**前端取不到字段** | 已用 `row.get({plain:true})` 拍平 |
| 8 | `wechatPayService.queryOrder` 返回结构不统一（mock 与真实模式字段名不同） | 查单同步逻辑在真实模式会取不到值 | 已统一为 `tradeState`/`transactionId` |
| 9 | 静态路径 `/summary` `/export` 定义在 `/:id` 之后 | 会被 `/:id` 吃掉 | 已调整顺序，并加测试断言防回归 |

> ⚠️ **新增路由时的规矩**：静态段（`/summary`、`/export`、`/list/bd`、`/pending`）
> 必须写在 `/:id` **之前**，否则 Express 会先匹配到动态段。

---

## 10. 自检与回归

```bash
cd D:/ec9/backend

# 启动服务（后台）
node app.js

# 后台管理接口自检（86 项，HTTP 层）
node scripts/test-admin-api.js

# 核心业务自检（27 项，直驱服务层）
node selftest.js

# 支付单测（20 项）
node test-payment.js

# 支付 HTTP 全链路（22 项）
node scripts/smoke-http.js

# 手机号 HMAC 一致性修复（幂等）
node scripts/fix-phone-hmac.js [--dry]

# 支付配置模块自检（26 项，直驱服务层，跑完自动还原）
node scripts/test-pay-config.js

# 支付配置 HTTP 冒烟（13 项，临时端口 7099）
node scripts/smoke-pay-config-http.js

# 支付配置页 UI 验证（10 项，Playwright 真浏览器）
node scripts/verify-paycfg-page.js

# 短信配置模块自检（29 项，直驱服务层，跑完自动还原）
node scripts/test-sms-config.js

# 短信配置 HTTP 冒烟（13 项，临时端口 7099）
node scripts/smoke-sms-config-http.js

# 短信配置页 UI 验证（10 项，Playwright 真浏览器）
node scripts/verify-smscfg-page.js

# 全流程演练 + 缺口扫描（87 项，真实 HTTP 走一遍客户会走的路）
node scripts/walkthrough-all-flows.js
```

当前结果：**86/86、27/27、20/20、22/22、26/26、13/13、10/10、29/29、13/13、10/10 全部通过**。

---

## 11. 待办

- [ ] 管理后台 UI（客户出设计稿，中英双语）
- [ ] H5 页面（`public/h5/` 目录目前为空）
- [ ] 优惠券模块（表已预留 `coupon_id`/`discount_amount`/`coupon_enabled` 字段，接口未做）
- [ ] 周边商品（表已预留 `product_type='merch'` 字段，接口未做）
- [ ] 部署到客户独立 PostgreSQL 库（当前连的是 `101.96.212.13/ec9`）
