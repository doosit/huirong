const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_PATH = path.join(__dirname, "huirong_loon_sign.js");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");
const WAP_KEYS = Array.from({ length: 10 }, (_, index) => `PUBLIC_CONFIG_KEY_${index}`);
const PUBLIC_CLIENT_SOURCE = [
  'function BaseConfig(){this.version="2.2.8";',
  `this.apiSign={wap_KEYS:${JSON.stringify(WAP_KEYS)},app_KEY:"APPTEST"};}`,
].join("");
const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const SERVER_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });

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
  assert.ok(!/TEMP_TOKEN|TEMP_SIGN|TEMP_RND|SHOULD_NOT_BE_STORED/.test(stored));
  assert.strictEqual(result.store.values.get("huirong.loon.action.sign"), "");
  assert.strictEqual(result.doneValues.length, 1);
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
    mallId: "MALL_1",
    deviceId: "DEVICE_1",
    clientType: "mini_weixin",
    model: "IOS",
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
      if (/\/api\/v3\/member\/[^/]+\/signs$/.test(url.pathname)) {
        jsonResponse(callback, {
          errorCode: "PUB-00000",
          body: { signInCreditValue: 5, continuousDays: 3 },
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
          body: { description: "测试奖品" },
        });
        return;
      }
      callback(`unhandled request: ${method} ${url.pathname}`);
    },
  });

  assert.ok(registerPayloadSeen);
  assert.strictEqual(result.doneValues.length, 1);
  assert.ok(result.notifications.some((item) => item.subtitle === "成功 2 项 / 共 2 项"));
  assert.ok(result.requests.every((item) => item.request["auto-cookie"] === false));

  const signRequest = result.requests.find((item) => /\/member\/[^/]+\/signs/.test(item.request.url));
  const countRequest = result.requests.find((item) => item.request.url.includes("/prizesactivity/member/remain/count"));
  const playRequest = result.requests.find((item) => item.request.url.includes("/prizesactivity/code/bigWheel/play"));
  assert.ok(signRequest && countRequest && playRequest);
  assert.strictEqual(queryObject(signRequest.request.url).sid, "SID_PERSISTENT");

  [signRequest, countRequest, playRequest].forEach((item) => {
    const signature = expectedSignature(item.request);
    assert.strictEqual(signature.actual, signature.expected);
  });

  const persisted = Array.from(result.store.values.values()).join("\n");
  assert.ok(!persisted.includes("RUNTIME_ACCESS_TOKEN"));
  assert.ok(!persisted.includes("RUNTIME_WORK_KEY"));
}

function testEmptyRequestRunsCronPath() {
  const result = runScript({
    argument: "action=sign",
    request: {},
  });
  assert.strictEqual(result.requests.length, 0);
  assert.ok(result.notifications.some((item) => item.subtitle === "初始化未完成"));
  assert.strictEqual(result.doneValues.length, 1);
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
}

testAuthCaptureDropsTemporaryFields();
testLotteryCaptureDropsTemporaryFields();
testDynamicExchangeAndTaskQueue();
testEmptyRequestRunsCronPath();
testSha256KnownVector();
console.log("huirong_loon_sign_test: all tests passed");
