# 汇融汇 Loon 签到抽奖

脚本持久化用户的 `sid` 会话以及会员、商场、活动、设备等稳定配置。每次定时任务都会读取当前公开 H5 配置，重新兑换设备 `accessToken/workKey`，并根据当前时间生成新的 `timestamp/rnd/sign`。临时权鉴、完整 URL、完整请求头和完整请求包不会写入持久化存储。

## 安装

在 Loon 中订阅：

```text
https://raw.githubusercontent.com/doosit/huirong/refs/heads/main/huirong.plugin
```

启用插件和 MITM 后：

1. 打开汇融汇小程序的会员页面，等待会话通知；页面会先保存 `sid`，再由积分状态请求补全签到所需的 `openId`。
2. 当天手动签到一次，让定位签到请求保存稳定的经纬度；脚本仅保存坐标，不保存该请求的临时权鉴。
3. 打开大转盘页面，等待“稳定配置抓取成功”通知；无需手动消耗抽奖次数。
4. 插件默认每天 08:00 依次执行签到和抽奖。

若小程序重新登录、切换账号或活动更换，重新打开上述页面即可覆盖对应的稳定配置。脚本不会按本地时间主动删除 `sid`；服务端确认失效时会提示重新抓取。

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

测试覆盖持久会话抓取、临时字段不落盘、动态设备注册、SHA256 请求签名、签到/抽奖队列以及空 `$request` 的 CRON 分流。
