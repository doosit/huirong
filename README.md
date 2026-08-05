# 汇融汇 Loon 签到抽奖

附件 HAR 中 `bop.mobcb.com` 没有 HTTP `Cookie` 请求头或 `Set-Cookie` 响应头。小程序实际长期复用的是请求参数 `sid`，因此脚本自动抓取并持久化 `sid`、会员身份、商场、定位和抽奖活动等稳定配置，不保存或发送传统 Cookie。

每次定时任务都会重新兑换设备 `accessToken`，并根据当前时间生成新的 `timestamp/rnd/sign`。临时权鉴、完整 URL、完整请求头和完整请求包不会写入持久化存储；服务端返回但当前明文请求不需要的 `workKey` 也不会保留。公开 H5 签名配置按带哈希的脚本 URL 缓存，版本变化时自动刷新。

`sid` 通过 Loon 的 `$persistentStore` 保存，脚本不设置本地过期时间，会一直保留到重新登录后被新值覆盖或用户清理 Loon 持久化数据。服务端仍有权使会话失效，所以不能把它理解为永不失效的 Cookie。

## 安装

在 Loon 中订阅：

```text
https://raw.githubusercontent.com/doosit/huirong/refs/heads/main/huirong.plugin
```

启用插件和 MITM 后：

1. 打开汇融汇小程序的会员页面，等待会话通知；页面请求会自动保存 `sid` 和设备信息，再由积分状态请求补全签到所需的 `openId`。
2. 当天手动签到一次，让定位签到请求保存稳定的经纬度；脚本仅保存坐标，不保存该请求的临时权鉴。
3. 打开大转盘页面，等待“稳定配置抓取成功”通知；无需手动消耗抽奖次数。
4. 插件默认每天 08:00 依次执行签到和抽奖。

若小程序重新登录、切换账号或活动更换，重新打开上述页面即可覆盖对应的稳定配置。检测到账号切换时，脚本不会沿用旧账号的 `openId` 和定位；签到与抽奖配置账号不一致时也会在联网执行前停止，避免串号。

抽奖接口本身不携带 `sid`，它使用持久化的 `memberId/activityId/mallId/deviceId` 配合每次新兑换的设备 `accessToken`。因此“长期会话”直接参与签到，抽奖则使用同一会员的稳定身份配置。

## 手动任务

插件默认使用：

```text
argument=action=all
```

也可在自定义任务中使用 `action=sign` 或 `action=lottery`。Loon 运行时需支持 `BigInt`，以便完成 RSA 设备注册。

## 本地验证

```bash
node --check huirong_loon_sign.js
node huirong_loon_sign_test.js
git diff --check
```

测试覆盖插件自动抓取规则、持久会话抓取、账号切换隔离、跨账号阻断、临时字段不落盘、公开配置缓存、动态设备注册、SHA256 请求签名、签到/抽奖队列以及空 `$request` 的 CRON 分流。
