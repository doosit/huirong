const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_PATH = path.join(__dirname, "huirong_loon_sign.js");
const PLUGIN_PATH = path.join(__dirname, "huirong.plugin");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");
const PLUGIN_SOURCE = fs.readFileSync(PLUGIN_PATH, "utf8");
const WAP_KEYS = Array.from({ length: 10 }, (_, index) => `PUBLIC_CONFIG_KEY_${index}`);
const PUBLIC_CLIENT_SOURCE = [
  'function BaseConfig(){this.version="2.2.8";',
  `this.apiSign={wap_KEYS:${JSON.stringify(WAP_KEYS)},app_KEY:"APPTEST"};}`,
].join("");
const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const SERVER_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });
const TEST_NOW = new Date();
const TEST_DATE = [
  TEST_NOW.getFullYear(),
  String(TEST_NOW.getMonth() + 1).padStart(2, "0"),
  String(TEST_NOW.getDate()).padStart(2, "0"),
].join("-");

function createStore(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    values,
    api: {
      read(key) {
        return values.get(key) || "";
      },
      write(value, key) {
        values.set(key, String(value));
        return true;
      },
    },
  };
}

function runScript(options) {
  const settings = options || {};
  const store = createStore(settings.store);
  const notifications = [];
  const logs = [];
  const requests = [];
  const doneValues = [];
  const httpHandler = settings.httpHandler || function(method, request, callback) {
    callback(`unexpected ${method} request: ${request.url}`);
  };

  const httpClient = {};
  ["get", "post", "put", "delete"].forEach((method) => {
    httpClient[method] = function(request, callback) {
      requests.push({ method, request });
      httpHandler(method, request, callback);
    };
  });

  const context = {
    $argument: settings.argument || "",
    $persistentStore: store.api,
    $notification: {
      post(title, subtitle, message) {
        notifications.push({ title, subtitle, message });
      },
    },
    $httpClient: httpClient,
    $done(value) {
      doneValues.push(value);
    },
    console: {
      log(message) {
        logs.push(String(message));
      },
    },
    crypto: crypto.webcrypto,
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
  };
  if (Object.prototype.hasOwnProperty.call(settings, "request")) {
    context.$request = settings.request;
  }

  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: SCRIPT_PATH });
  return { context, store, notifications, logs, requests, doneValues };
}

function jsonResponse(callback, body, status) {
  callback(null, { status: status || 200 }, JSON.stringify(body));
}

function queryObject(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

function expectedSignature(request) {
  const query = queryObject(request.url);
  const actual = query.sign;
  delete query.sign;
  delete query.signType;
  if (request.body) {
    query.body = request.body;
  }
  const canonical = Object.keys(query)
    .sort()
    .filter((key) => query[key] !== "")
    .map((key) => `${key}=${query[key]}`)
    .join("&");
  assert.ok(canonical.length > 0);
  const secret = WAP_KEYS[Number(query.timestamp) % 10];
  return {
    actual,
    expected: crypto.createHash("sha256").update(canonical + secret).digest("hex"),
  };
}

function testPluginAutomaticCaptureRules() {
  const rules = PLUGIN_SOURCE.split(/\r?\n/)
    .filter((line) => line.startsWith("http-request "))
    .map((line) => {
      const separator = line.indexOf(" script-path=");
      return {
        line,
        pattern: new RegExp(line.slice("http-request ".length, separator)),
      };
    });
  const samples = [
    ["/api/v3/miniapp/material/info/user?sid=test", false],
    ["/api/v3/prizesactivity/member/remain/count?activityId=test", false],
  ];

  assert.strictEqual(rules.length, samples.length);
  samples.forEach(([pathName, requiresBody], index) => {
    assert.ok(rules[index].pattern.test(`https://bop.mobcb.com${pathName}`));
    assert.strictEqual(/requires-body=true/.test(rules[index].line), requiresBody);
  });
}

function testAuthCaptureDropsTemporaryFields() {
  const legacyPacket = JSON.stringify({ accessToken: "LEGACY_TEMP_TOKEN" });
  const result = runScript({
    argument: "capture=auth",
    store: {
      "huirong.loon.action.sign": legacyPacket,
    },
    request: {
      method: "GET",
      url: "https://bop.mobcb.com/api/v3/miniapp/material/info/user?sid=SID_PERSISTENT&appUid=MEMBER_12345678&mallId=MALL_1&deviceId=DEVICE_1&clientType=mini_weixin&model=IOS&accessToken=TEMP_TOKEN&timestamp=123&rnd=TEMP_RND&sign=TEMP_SIGN",
      headers: { Cookie: "SHOULD_NOT_BE_STORED=1" },
    },
  });

  const stored = result.store.values.get("huirong.loon.auth.v2");
  const auth = JSON.parse(stored);
  assert.strictEqual(auth.sid, "SID_PERSISTENT");
  assert.strictEqual(auth.memberId, "MEMBER_12345678");
  assert.strictEqual(auth.mallId, "MALL_1");
  assert.strictEqual(auth.version, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "openId"));
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "latitude"));
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "longitude"));
  assert.ok(!/TEMP_TOKEN|TEMP_SIGN|TEMP_RND|SHOULD_NOT_BE_STORED/.test(stored));
  assert.strictEqual(result.store.values.get("huirong.loon.action.sign"), "");
  assert.strictEqual(result.doneValues.length, 1);
}

function testAccountSwitchDoesNotReuseOldIdentityDetails() {
  const previous = {
    version: 2,
    sid: "SID_OLD",
    memberId: "MEMBER_OLD",
    openId: "OPENID_OLD",
    mallId: "MALL_OLD",
    latitude: "30.100000",
    longitude: "104.100000",
    deviceId: "DEVICE_OLD",
    clientType: "mini_weixin",
    model: "IOS",
  };
  const result = runScript({
    argument: "capture=auth",
    store: {
      "huirong.loon.auth.v2": JSON.stringify(previous),
    },
    request: {
      method: "GET",
      url: "https://bop.mobcb.com/api/v3/miniapp/material/info/user?sid=SID_NEW&appUid=MEMBER_NEW&mallId=MALL_NEW&deviceId=DEVICE_NEW",
      headers: {},
    },
  });

  const auth = JSON.parse(result.store.values.get("huirong.loon.auth.v2"));
  assert.strictEqual(auth.sid, "SID_NEW");
  assert.strictEqual(auth.memberId, "MEMBER_NEW");
  assert.strictEqual(auth.mallId, "MALL_NEW");
  assert.strictEqual(auth.deviceId, "DEVICE_NEW");
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "openId"));
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "latitude"));
  assert.ok(!Object.prototype.hasOwnProperty.call(auth, "longitude"));
  assert.ok(result.notifications.some((item) => item.subtitle === "检测到账号切换"));
}

function testLotteryCaptureDropsTemporaryFields() {
  const result = runScript({
    argument: "capture=lottery",
    request: {
      method: "GET",
      url: "https://bop.mobcb.com/api/v3/prizesactivity/member/remain/count?activityId=ACTIVITY_1&memberId=MEMBER_12345678&mallId=MALL_1&code=bigWheel&deviceId=DEVICE_1&clientType=mini_weixin&currentPageType=/game/bigWheel&model=IOS&accessToken=TEMP_TOKEN&timestamp=123&rnd=TEMP_RND&sign=TEMP_SIGN",
      headers: {},
    },
  });

  const stored = result.store.values.get("huirong.loon.lottery.v2");
  const lottery = JSON.parse(stored);
  assert.strictEqual(lottery.activityId, "ACTIVITY_1");
  assert.strictEqual(lottery.code, "bigWheel");
  assert.ok(!/TEMP_TOKEN|TEMP_SIGN|TEMP_RND/.test(stored));
}

function testDynamicExchangeAndTaskQueue() {
  const auth = {
    version: 2,
    sid: "SID_PERSISTENT",
    memberId: "MEMBER_12345678",
    openId: "OPENID_123456789012345678901",
    mallId: "MALL_1",
    latitude: "30.000000",
    longitude: "104.000000",
    deviceId: "DEVICE_1",
    clientType: "mini_weixin",
    model: "IOS",
    capturedAt: 1,
  };
  const lottery = {
    version: 2,
    activityId: "ACTIVITY_1",
    memberId: "MEMBER_12345678",
    mallId: "MALL_1",
    code: "bigWheel",
    deviceId: "DEVICE_1",
    clientType: "mini_weixin",
    currentPageType: "/game/bigWheel",
    model: "IOS",
  };
  let registerPayloadSeen = false;

  const result = runScript({
    argument: "action=all",
    store: {
      "huirong.loon.auth.v2": JSON.stringify(auth),
      "huirong.loon.lottery.v2": JSON.stringify(lottery),
    },
    request: {},
    httpHandler(method, request, callback) {
      const url = new URL(request.url);
      if (url.pathname === "/uniappweb/") {
        callback(null, { status: 200 }, '<script src="js/showcase.test.js"></script>');
        return;
      }
      if (url.pathname === "/uniappweb/js/showcase.test.js") {
        callback(null, { status: 200 }, PUBLIC_CLIENT_SOURCE);
        return;
      }
      if (url.pathname === "/api/v3/securities/rsa/pubkey") {
        jsonResponse(callback, { errorCode: "PUB-00000", body: { publicKey: SERVER_PUBLIC_KEY } });
        return;
      }
      if (url.pathname === "/api/v3/securities/devices/register") {
        const payload = JSON.parse(request.body);
        assert.ok(payload.reqBody.length > 100);
        assert.doesNotThrow(() => Buffer.from(payload.reqBody, "base64"));
        registerPayloadSeen = true;
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: {
            accessToken: "RUNTIME_ACCESS_TOKEN",
            workKey: "RUNTIME_WORK_KEY",
            sessionValiditySeconds: 2592000,
          },
        });
        return;
      }
      if (url.pathname === "/api/v3/member/MEMBER_12345678/signs") {
        assert.strictEqual(method, "post");
        assert.deepStrictEqual(JSON.parse(request.body), { mallId: "MALL_1" });
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: { signInCreditValue: 5, continuousDays: 3 },
        });
        return;
      }
      if (url.pathname === "/api/v3/member/MEMBER_12345678/mall/crm/balance") {
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: { accounts: { credit: 128 } },
        });
        return;
      }
      if (url.pathname === "/api/v3/member/MEMBER_12345678/mall/crm/credits/bills") {
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: [
            { reason: "参与【每日积分大转盘】获得积分", time: `${TEST_DATE} 09:00:00`, type: 0, amount: 2 },
            { reason: "每日签到", time: `${TEST_DATE} 08:00:00`, type: 0, amount: 5 },
          ],
        });
        return;
      }
      if (url.pathname === "/api/v3/prizesactivity/member/remain/count") {
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: { remainningCount: 1 },
        });
        return;
      }
      if (url.pathname === "/api/v3/prizesactivity/code/bigWheel/play") {
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: {
            prizeType: "credit",
            prizeName: "2积分",
            description: "恭喜您获得“2积分”",
          },
        });
        return;
      }
      callback(`unhandled request: ${method} ${url.pathname}`);
    },
  });

  assert.ok(registerPayloadSeen);
  assert.strictEqual(result.doneValues.length, 1);
  assert.ok(result.notifications.some((item) => item.subtitle === "签到：成功 · 抽奖：成功"));
  assert.ok(result.notifications.some((item) => /签到状态：签到成功/.test(item.message)));
  assert.ok(result.notifications.some((item) => /今日签到积分：\+5/.test(item.message)));
  assert.ok(result.notifications.some((item) => /抽奖状态：恭喜您获得/.test(item.message)));
  assert.ok(result.notifications.some((item) => /今日抽奖积分：\+2/.test(item.message)));
  assert.ok(result.notifications.some((item) => /任务积分：\+7/.test(item.message)));
  assert.ok(result.notifications.some((item) => /当前总计：128/.test(item.message)));
  assert.ok(result.notifications.some((item) => /最近记录：\+2 参与【每日积分大转盘】获得积分/.test(item.message)));
  assert.strictEqual(result.logs.length, 1);
  assert.ok(result.logs[0].includes("╭──── 汇融每日任务"));
  assert.ok(!result.logs[0].includes("临时设备权鉴"));
  assert.ok(result.requests.every((item) => item.request["auto-cookie"] === false));

  const signRequest = result.requests.find((item) => item.request.url.includes("/member/MEMBER_12345678/signs"));
  const balanceRequest = result.requests.find((item) => item.request.url.includes("/mall/crm/balance"));
  const billsRequest = result.requests.find((item) => item.request.url.includes("/mall/crm/credits/bills"));
  const countRequest = result.requests.find((item) => item.request.url.includes("/prizesactivity/member/remain/count"));
  const playRequest = result.requests.find((item) => item.request.url.includes("/prizesactivity/code/bigWheel/play"));
  assert.ok(signRequest && balanceRequest && billsRequest && countRequest && playRequest);
  assert.strictEqual(queryObject(signRequest.request.url).sid, "SID_PERSISTENT");
  assert.strictEqual(queryObject(billsRequest.request.url).activityCreditAccountUseType, "general");
  assert.strictEqual(queryObject(billsRequest.request.url).page, "0");
  assert.strictEqual(queryObject(billsRequest.request.url).pagesize, "50");
  assert.ok(billsRequest.request.url.includes("%20"));
  assert.ok(billsRequest.request.url.includes("%3A"));

  [signRequest, balanceRequest, billsRequest, countRequest, playRequest].forEach((item) => {
    const signature = expectedSignature(item.request);
    assert.strictEqual(signature.actual, signature.expected);
  });

  const persisted = Array.from(result.store.values.values()).join("\n");
  assert.ok(!persisted.includes("RUNTIME_ACCESS_TOKEN"));
  assert.ok(!persisted.includes("RUNTIME_WORK_KEY"));
  assert.ok(!persisted.includes("OPENID_123456789012345678901"));
  assert.ok(!persisted.includes("30.000000"));
  assert.ok(result.store.values.has("huirong.loon.public-config.v1"));
}

function testPublicConfigCacheAvoidsShowcaseDownload() {
  const cached = {
    cacheVersion: 1,
    appKey: "APPTEST",
    version: "2.2.8",
    wapKeys: WAP_KEYS,
    sourceUrl: "https://bop.mobcb.com/uniappweb/js/showcase.test.js",
    cachedAt: 1,
  };
  const result = runScript({
    argument: "capture=unknown&debug=true",
    store: {
      "huirong.loon.public-config.v1": JSON.stringify(cached),
    },
    request: { url: "https://bop.mobcb.com/ignored", method: "GET" },
    httpHandler(method, request, callback) {
      const url = new URL(request.url);
      assert.strictEqual(method, "get");
      assert.strictEqual(url.pathname, "/uniappweb/");
      callback(null, { status: 200 }, '<script src="js/showcase.test.js"></script>');
    },
  });

  let loaded;
  result.context.loadPublicClientConfig((error, config) => {
    assert.ifError(error);
    loaded = config;
  });
  assert.strictEqual(loaded.appKey, "APPTEST");
  assert.strictEqual(result.requests.length, 1);
  assert.ok(result.logs.some((line) => line.includes("复用当前版本")));
}

function testMismatchedAccountsAreBlockedBeforeNetwork() {
  const auth = {
    sid: "SID_A",
    memberId: "MEMBER_A",
    openId: "OPENID_A",
    mallId: "MALL_1",
    latitude: "30",
    longitude: "104",
    deviceId: "DEVICE_1",
  };
  const lottery = {
    activityId: "ACTIVITY_1",
    memberId: "MEMBER_B",
    mallId: "MALL_1",
    code: "bigWheel",
    deviceId: "DEVICE_1",
  };
  const result = runScript({
    argument: "action=all",
    store: {
      "huirong.loon.auth.v2": JSON.stringify(auth),
      "huirong.loon.lottery.v2": JSON.stringify(lottery),
    },
    request: {},
  });

  assert.strictEqual(result.requests.length, 0);
  assert.ok(result.notifications.some((item) => item.subtitle === "账号配置不一致"));
}

function testEmptyRequestRunsCronPath() {
  const result = runScript({
    argument: "action=sign",
    request: {},
  });
  assert.strictEqual(result.requests.length, 0);
  assert.ok(result.notifications.some((item) => item.subtitle === "初始化未完成"));
  assert.strictEqual(result.doneValues.length, 1);
  assert.ok(!result.logs.some((line) => line.includes("版本:")));

  const debugResult = runScript({
    argument: "action=sign&debug=true",
    request: {},
  });
  assert.ok(debugResult.logs.some((line) => line.includes("版本: 20260805-3")));
}

function testNonJsonHttpErrorIncludesSafeMetadata() {
  const result = runScript({
    argument: "capture=unknown",
    request: { url: "https://bop.mobcb.com/ignored", method: "GET" },
  });
  const parsed = result.context.parseBusinessResponse(
    "签到",
    null,
    {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<html>Bad Request</html>",
    },
    undefined
  );
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.detail.includes("Content-Type text/html"));
  assert.ok(parsed.detail.includes("24 字节"));
  assert.ok(!parsed.detail.includes("Bad Request"));
}

function testSha256KnownVector() {
  const result = runScript({
    argument: "capture=unknown",
    request: { url: "https://bop.mobcb.com/ignored", method: "GET" },
  });
  assert.strictEqual(
    result.context.sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.strictEqual(result.context.isAlreadyCompleted("", "MBR-00029"), true);
}

testPluginAutomaticCaptureRules();
testAuthCaptureDropsTemporaryFields();
testAccountSwitchDoesNotReuseOldIdentityDetails();
testLotteryCaptureDropsTemporaryFields();
testDynamicExchangeAndTaskQueue();
testPublicConfigCacheAvoidsShowcaseDownload();
testMismatchedAccountsAreBlockedBeforeNetwork();
testEmptyRequestRunsCronPath();
testNonJsonHttpErrorIncludesSafeMetadata();
testSha256KnownVector();
console.log("huirong_loon_sign_test: all tests passed");
