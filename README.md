# 汇融汇 Loon 签到抽奖

附件 HAR 中 `bop.mobcb.com` 没有 HTTP `Cookie` 请求头或 `Set-Cookie` 响应头。小程序实际长期复用的是请求参数 `sid`，因此脚本自动抓取并持久化 `sid`、会员身份、商场、设备和抽奖活动等稳定配置，不保存或发送传统 Cookie。

每次定时任务都会重新兑换设备 `accessToken`，并根据当前时间生成新的 `timestamp/rnd/sign`。临时权鉴、完整 URL、完整请求头和完整请求包不会写入持久化存储；服务端返回但当前明文请求不需要的 `workKey` 也不会保留。公开 H5 签名配置按带哈希的脚本 URL 缓存，版本变化时自动刷新。

`sid` 通过 Loon 的 `$persistentStore` 保存，脚本不设置本地过期时间，会一直保留到重新登录后被新值覆盖或用户清理 Loon 持久化数据。服务端仍有权使会话失效，所以不能把它理解为永不失效的 Cookie。

## 安装

在 Loon 中订阅：

```text
https://raw.githubusercontent.com/doosit/huirong/refs/heads/main/huirong.plugin
```

启用插件和 MITM 后：

1. 打开汇融汇小程序的会员页面，等待会话通知；页面请求会自动保存签到所需的 `sid`、会员、商场和设备信息。
2. 打开大转盘页面，等待“稳定配置抓取成功”通知；无需手动消耗抽奖次数。
3. 插件默认每天 08:00 依次执行签到和抽奖。

若小程序重新登录、切换账号或活动更换，重新打开上述页面即可覆盖对应的稳定配置。签到与抽奖配置账号不一致时会在联网执行前停止，避免串号。旧版保存的 `openId` 和定位会自动清理，因为真实签到接口不需要这些字段。

签到使用 H5 客户端的 `POST /member/{memberId}/signs` 接口，并按其底层 `HttpService.POP` 行为在请求体中携带 `mallId`。成功或今日已签到后，脚本会继续读取“我的积分”使用的积分明细与余额接口，并返回本次签到积分、最近一笔积分记录和当前总积分。

抽奖接口本身不携带 `sid`，它使用持久化的 `memberId/activityId/mallId/deviceId` 配合每次新兑换的设备 `accessToken`。因此“长期会话”直接参与签到，抽奖则使用同一会员的稳定身份配置。

## 手动任务

插件默认使用：

```text
argument=action=all
```

也可在自定义任务中使用 `action=sign` 或 `action=lottery`。Loon 运行时需支持 `BigInt`，以便完成 RSA 设备注册。

默认模式只输出一份多行任务日报。需要排查接口过程时，可临时使用 `action=all&debug=true` 开启详细日志；正常定时任务不要开启调试。

## 本地验证

```bash
node --check huirong_loon_sign.js
node huirong_loon_sign_test.js
git diff --check
```

测试覆盖插件自动抓取规则、持久会话抓取、旧定位数据清理、账号切换隔离、跨账号阻断、临时字段不落盘、公开配置缓存、动态设备注册、SHA256 请求签名、真实签到请求结构、积分明细/总积分查询、签到/抽奖队列以及空 `$request` 的 CRON 分流。
