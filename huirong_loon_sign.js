/*
 * 汇融汇 Loon 签到与抽奖脚本
 *
 * 持久化内容：
 * - sid、会员 ID、商场 ID、设备 ID 等用户会话与业务配置
 * - 抽奖活动 ID、设备 ID 等稳定参数
 *
 * 不持久化内容：
 * - accessToken、workKey、timestamp、rnd、sign
 * - 完整请求 URL、请求头或请求包
 *
 * 定时任务会读取或复用公开 H5 配置，重新注册设备会话，并为每个请求生成当前签名。
 */

const API_BASE = "https://bop.mobcb.com/api/v3/";
const WEB_INDEX_URL = "https://bop.mobcb.com/uniappweb/";
const STORE_KEYS = {
  auth: "huirong.loon.auth.v2",
  lottery: "huirong.loon.lottery.v2",
  publicConfig: "huirong.loon.public-config.v1",
  lock: "huirong.loon.runtime.lock.v2",
};
const LEGACY_STORE_KEYS = [
  "huirong.loon.action.sign",
  "huirong.loon.action.lottery",
];
const SCRIPT_NAME = "汇融任务";
const SCRIPT_VERSION = "20260805-3";
const TIMEOUT_MS = 20000;
const LOCK_TTL_MS = 2 * 60 * 1000;
const INTER_ACTION_DELAY_MS = 1200;
const MAX_NOTIFICATION_DETAIL = 260;
const runtimeState = {
  runId: createRunId(),
  lockAcquired: false,
  completed: false,
  lastMessage: "",
  debug: false,
};

main();

function main() {
  const args = parseArgument(typeof $argument === "string" ? $argument : "");
  runtimeState.debug = isDebugEnabled(args.debug);
  clearLegacyTemporaryPackets();
  minimizeStoredAuth();

  if (hasHttpRequest()) {
    captureRequest(args.capture || "");
    return;
  }

  const action = args.action || "all";
  log(`版本: ${SCRIPT_VERSION} | 运行模式: CRON/GENERIC | action=${action}`);
  if (["all", "sign", "lottery"].indexOf(action) === -1) {
    finish(`不支持的 action: ${action}`);
    return;
  }

  if (!acquireLock(action)) {
    finish("检测到脚本已在运行", false, "为避免重复签到或抽奖，本次执行已跳过");
    return;
  }

  runTask(action);
}

function hasHttpRequest() {
  return (
    typeof $request !== "undefined" &&
    $request &&
    typeof $request.url === "string" &&
    /^https?:\/\//i.test($request.url)
  );
}

function captureRequest(explicitType) {
  const url = $request.url;
  const captureType = explicitType || detectCaptureType(url);
  log(`运行模式: HTTP-REQUEST | capture=${captureType || "unknown"} | path=${getUrlPath(url)}`);

  if (captureType === "auth") {
    captureAuth(url);
    return;
  }
  if (captureType === "lottery") {
    captureLottery(url);
    return;
  }

  finish("未识别的抓取请求", true);
}

function detectCaptureType(url) {
  const path = getUrlPath(url);
  if (/\/api\/v3\/miniapp\/material\/info\/user$/i.test(path)) {
    return "auth";
  }
  if (
    /\/api\/v3\/prizesactivity\/member\/remain\/count$/i.test(path) ||
    /\/api\/v3\/prizesactivity\/code\/[^/]+\/play$/i.test(path)
  ) {
    return "lottery";
  }
  return "";
}

function captureAuth(url) {
  const query = getQueryObject(url);
  const previous = readJSON(STORE_KEYS.auth) || {};
  const incomingSid = query.sid || "";
  const incomingMemberId = query.appUid || query.memberId || "";
  const accountChanged = hasIdentityChanged(previous, incomingSid, incomingMemberId);
  const retained = accountChanged ? {} : previous;
  const sid = incomingSid || retained.sid || "";
  const memberId = incomingMemberId || retained.memberId || "";
  const mallId = query.mallId || retained.mallId || "";

  if (isBlank(sid) || isBlank(memberId) || isBlank(mallId)) {
    finish(
      "账号会话抓取失败",
      false,
      `缺少稳定字段: ${[
        isBlank(sid) ? "sid" : "",
        isBlank(memberId) ? "memberId" : "",
        isBlank(mallId) ? "mallId" : "",
      ].filter(Boolean).join(", ")}`
    );
    return;
  }

  const auth = {
    version: 3,
    sid: String(sid),
    memberId: String(memberId),
    mallId: String(mallId),
    deviceId: String(query.deviceId || retained.deviceId || ""),
    clientType: String(query.clientType || retained.clientType || "mini_weixin"),
    model: String(query.model || retained.model || "IOS"),
    capturedAt: Date.now(),
  };

  if (!writeJSON(STORE_KEYS.auth, auth)) {
    finish("账号会话保存失败");
    return;
  }

  if (accountChanged) {
    notify(
      "汇融账号会话",
      "检测到账号切换",
      "已保存新账号的 sid、会员、商场和设备信息"
    );
  } else {
    notify(
      "汇融账号会话",
      "持久会话抓取成功",
      `会员: ${maskValue(auth.memberId, 4, 4)} | 已保存 sid，未保存临时 accessToken/sign`
    );
  }
  done({});
}

function captureLottery(url) {
  const query = getQueryObject(url);
  const body = safeJsonParse(normalizeBody($request.body));
  const previous = readJSON(STORE_KEYS.lottery) || {};
  const activityId = query.activityId || (body && body.activityId) || previous.activityId || "";
  const memberId = query.memberId || (body && body.memberId) || previous.memberId || "";
  const mallId = query.mallId || (body && body.mallId) || previous.mallId || "";
  const code = query.code || extractLotteryCode(getUrlPath(url)) || previous.code || "bigWheel";
  const deviceId = query.deviceId || previous.deviceId || "";

  if ([activityId, memberId, mallId, deviceId].some(isBlank)) {
    finish(
      "抽奖配置抓取失败",
      false,
      `缺少稳定字段: ${[
        isBlank(activityId) ? "activityId" : "",
        isBlank(memberId) ? "memberId" : "",
        isBlank(mallId) ? "mallId" : "",
        isBlank(deviceId) ? "deviceId" : "",
      ].filter(Boolean).join(", ")}`
    );
    return;
  }

  const lottery = {
    version: 2,
    activityId: String(activityId),
    memberId: String(memberId),
    mallId: String(mallId),
    code: String(code),
    deviceId: String(deviceId),
    clientType: String(query.clientType || previous.clientType || "mini_weixin"),
    currentPageType: String(query.currentPageType || previous.currentPageType || "/game/bigWheel"),
    model: String(query.model || previous.model || "IOS"),
    capturedAt: Date.now(),
  };

  if (!writeJSON(STORE_KEYS.lottery, lottery)) {
    finish("抽奖配置保存失败");
    return;
  }

  notify(
    "汇融抽奖配置",
    "稳定配置抓取成功",
    `活动: ${maskValue(lottery.activityId, 4, 4)} | 未保存 accessToken/timestamp/rnd/sign`
  );
  done({});
}

function runTask(action) {
  const auth = readJSON(STORE_KEYS.auth);
  const lottery = readJSON(STORE_KEYS.lottery);
  const missing = [];

  if ((action === "all" || action === "sign") && !isValidAuth(auth)) {
    missing.push("账号持久会话");
  }
  if ((action === "all" || action === "lottery") && !isValidLottery(lottery)) {
    missing.push("抽奖稳定配置");
  }
  if (missing.length) {
    finish("初始化未完成", false, `缺少${missing.join("、")}，请按插件提示打开小程序对应页面`);
    return;
  }
  if (action === "all" && !hasSameBusinessIdentity(auth, lottery)) {
    finish(
      "账号配置不一致",
      false,
      "签到会话与抽奖配置不属于同一会员或商场，请重新打开大转盘页完成抓取"
    );
    return;
  }

  loadPublicClientConfig(function(error, config) {
    if (error) {
      finish("读取公开客户端配置失败", false, String(error));
      return;
    }

    const profile = action === "lottery" ? lottery : auth;
    const deviceId = profile && profile.deviceId;
    if (!deviceId) {
      finish("设备配置缺失", false, "请重新打开抽奖页或会员页完成抓取");
      return;
    }

    exchangeDeviceSession(config, deviceId, function(sessionError, session) {
      if (sessionError) {
        finish("临时设备权鉴兑换失败", false, String(sessionError));
        return;
      }

      log("临时设备权鉴兑换成功，仅在本次运行内存中使用");
      runActionQueue(action, config, session, auth, lottery);
    });
  });
}

function runActionQueue(action, config, session, auth, lottery) {
  const queue = action === "all" ? ["sign", "lottery"] : [action];
  const results = [];

  function next(index) {
    if (index >= queue.length) {
      finalizeTaskResults(config, session, auth, results);
      return;
    }

    const key = queue[index];
    const callback = function(result) {
      results.push(result);
      delay(INTER_ACTION_DELAY_MS, function() {
        next(index + 1);
      });
    };

    if (key === "sign") {
      executeSign(config, session, auth, callback);
      return;
    }
    executeLottery(config, session, lottery, callback);
  }

  next(0);
}

function finalizeTaskResults(config, session, auth, results) {
  if (!isValidAuth(auth)) {
    notifyAllResults(results, {});
    done();
    return;
  }
  delay(500, function() {
    queryCreditSummary(config, session, auth, function(summary) {
      notifyAllResults(results, summary);
      done();
    });
  });
}

function loadPublicClientConfig(callback) {
  httpRequest("get", { url: WEB_INDEX_URL }, function(indexError, indexResponse, indexData) {
    if (indexError) {
      callback(`H5 首页请求失败: ${indexError}`);
      return;
    }
    if (getStatusCode(indexResponse) !== 200) {
      callback(`H5 首页返回 HTTP ${getStatusCode(indexResponse) || 0}`);
      return;
    }

    const match = String(indexData || "").match(/(?:src=["'])([^"']*js\/showcase\.[^"']+\.js)(?:["'])/i);
    if (!match) {
      callback("未找到当前 showcase 客户端脚本");
      return;
    }

    const scriptUrl = resolveWebUrl(match[1]);
    const cached = readJSON(STORE_KEYS.publicConfig);
    if (isValidPublicClientConfig(cached) && cached.sourceUrl === scriptUrl) {
      log("复用当前版本的公开 H5 签名配置");
      callback(null, cached);
      return;
    }

    httpRequest("get", { url: scriptUrl }, function(scriptError, scriptResponse, scriptData) {
      if (scriptError) {
        callback(`公开客户端脚本请求失败: ${scriptError}`);
        return;
      }
      if (getStatusCode(scriptResponse) !== 200) {
        callback(`公开客户端脚本返回 HTTP ${getStatusCode(scriptResponse) || 0}`);
        return;
      }

      try {
        const source = String(scriptData || "");
        const authMatch = source.match(/wap_KEYS\s*:\s*(\[[^\]]+\])\s*,\s*app_KEY\s*:\s*["']([^"']+)["']/);
        const versionMatch = source.match(/this\.version\s*=\s*["']([^"']+)["']/);
        if (!authMatch || !versionMatch) {
          throw new Error("公开客户端权鉴配置结构已变化");
        }
        const wapKeys = JSON.parse(authMatch[1]);
        if (!Array.isArray(wapKeys) || wapKeys.length !== 10 || wapKeys.some(isBlank)) {
          throw new Error("公开客户端签名配置不完整");
        }
        const config = {
          cacheVersion: 1,
          appKey: authMatch[2],
          version: versionMatch[1],
          wapKeys,
          sourceUrl: scriptUrl,
          cachedAt: Date.now(),
        };
        writeJSON(STORE_KEYS.publicConfig, config);
        callback(null, config);
      } catch (error) {
        callback(error.message || String(error));
      }
    });
  });
}

function exchangeDeviceSession(config, deviceId, callback) {
  if (typeof BigInt !== "function") {
    callback("当前 Loon JavaScript 运行时不支持 BigInt，无法完成 RSA 设备注册");
    return;
  }

  const pubkeyParams = {
    appKey: config.appKey,
    deviceId,
    rnd: generateMixed(20),
  };
  const pubkeyUrl = `${API_BASE}securities/rsa/pubkey?${buildQueryString(pubkeyParams)}`;

  httpRequest("get", { url: pubkeyUrl }, function(pubkeyError, pubkeyResponse, pubkeyData) {
    if (pubkeyError) {
      callback(`RSA 公钥请求失败: ${pubkeyError}`);
      return;
    }
    const pubkeyJson = safeJsonParse(pubkeyData);
    if (getStatusCode(pubkeyResponse) !== 200 || !isApiSuccess(pubkeyJson)) {
      callback(buildApiError("RSA 公钥请求未成功", pubkeyResponse, pubkeyJson));
      return;
    }

    const serverPublicKey = pubkeyJson.body && pubkeyJson.body.publicKey;
    if (!serverPublicKey) {
      callback("RSA 公钥响应缺少 publicKey");
      return;
    }

    let reqBody;
    try {
      const registration = {
        keySeed: generateMixed(30),
        clientPublicKey: generateEphemeralClientPublicKey(),
      };
      reqBody = rsaEncryptLong(JSON.stringify(registration), serverPublicKey);
    } catch (error) {
      callback(`构建设备注册请求失败: ${error.message || error}`);
      return;
    }

    const registerParams = {
      appKey: config.appKey,
      deviceId,
      rnd: generateMixed(20),
    };
    const registerUrl = `${API_BASE}securities/devices/register?${buildQueryString(registerParams)}`;
    httpRequest(
      "post",
      {
        url: registerUrl,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reqBody }),
      },
      function(registerError, registerResponse, registerData) {
        if (registerError) {
          callback(`设备注册请求失败: ${registerError}`);
          return;
        }
        const registerJson = safeJsonParse(registerData);
        if (getStatusCode(registerResponse) !== 200 || !isApiSuccess(registerJson)) {
          callback(buildApiError("设备注册未成功", registerResponse, registerJson));
          return;
        }
        if (!registerJson.body || typeof registerJson.body !== "object") {
          callback("设备注册响应为加密格式，当前运行时无法安全解密");
          return;
        }
        if (!registerJson.body.accessToken) {
          callback("设备注册响应缺少 accessToken");
          return;
        }
        callback(null, {
          accessToken: String(registerJson.body.accessToken),
          deviceId: String(deviceId),
        });
      }
    );
  });
}

function executeSign(config, session, auth, callback) {
  const bodyText = JSON.stringify({ mallId: auth.mallId });
  const params = buildCommonParams(config, session, auth, {
    mallId: auth.mallId,
    appUid: auth.memberId,
    sid: auth.sid,
    currentPageType: "/member/signin",
  });
  signRequestParams(params, bodyText, config.wapKeys);
  const url = `${API_BASE}member/${encodeURIComponent(auth.memberId)}/signs?${buildQueryString(params)}`;

  log("准备执行: 签到 | path=/api/v3/member/{memberId}/signs");
  httpRequest(
    "post",
    {
      url,
      headers: buildBusinessHeaders(false),
      body: bodyText,
    },
    function(error, response, data) {
      const result = parseBusinessResponse("签到", error, response, data);
      const details = [];
      if (!result.ok && isAlreadyCompleted(result.message, result.json && result.json.errorCode)) {
        result.ok = true;
        result.title = "汇融签到";
        result.subtitle = "今日已签到";
        details.push("今日已签到");
      } else if (result.ok) {
        const json = result.json;
        const body = json && json.body;
        if (body && typeof body.signInCreditValue !== "undefined") {
          result.pointsEarned = Number(body.signInCreditValue);
          details.push(`本次积分 +${body.signInCreditValue}`);
        }
        if (body && typeof body.continuousDays !== "undefined") {
          result.continuousDays = Number(body.continuousDays);
          details.push(`连续签到 ${body.continuousDays} 天`);
        }
        result.title = "汇融签到";
        result.subtitle = "执行成功";
      }
      result.actionName = "签到";
      if (!result.ok) {
        delete result.json;
        callback(result);
        return;
      }
      result.detail = details.join(" | ") || "签到成功";
      delete result.json;
      callback(result);
    }
  );
}

function queryCreditSummary(config, session, auth, callback) {
  const summary = {};
  queryCreditBalance(config, session, auth, function(balanceError, totalCredit) {
    if (balanceError) {
      summary.totalError = balanceError;
    } else {
      summary.totalCredit = totalCredit;
    }
    queryCreditBills(config, session, auth, function(billsError, bills) {
      if (billsError) {
        summary.billsError = billsError;
      } else {
        summary.bills = bills;
        const daily = summarizeTodayCredits(bills);
        Object.keys(daily).forEach(function(key) {
          summary[key] = daily[key];
        });
      }
      callback(summary);
    });
  });
}

function queryCreditBalance(config, session, auth, callback) {
  const params = buildCommonParams(config, session, auth, {
    mallId: auth.mallId,
    appUid: auth.memberId,
    sid: auth.sid,
    currentPageType: "userCredit",
  });
  signRequestParams(params, "", config.wapKeys);
  const url = `${API_BASE}member/${encodeURIComponent(auth.memberId)}/mall/crm/balance?${buildQueryString(params)}`;

  log("准备查询: 当前总积分");
  httpRequest("get", { url, headers: buildBusinessHeaders(false) }, function(error, response, data) {
    const result = parseBusinessResponse("总积分查询", error, response, data);
    if (!result.ok) {
      callback(result.detail || result.message || "查询失败");
      return;
    }
    const accounts = result.json && result.json.body && result.json.body.accounts;
    if (!accounts || isBlank(accounts.credit)) {
      callback("响应缺少 accounts.credit");
      return;
    }
    callback(null, String(accounts.credit));
  });
}

function queryCreditBills(config, session, auth, callback) {
  const range = getCurrentMonthRange();
  const params = buildCommonParams(config, session, auth, {
    mallId: auth.mallId,
    appUid: auth.memberId,
    sid: auth.sid,
    currentPageType: "userCredit",
  });
  params.activityCreditAccountUseType = "general";
  params.starttime = range.start;
  params.endtime = range.end;
  params.page = 0;
  params.pagesize = 50;
  signRequestParams(params, "", config.wapKeys);
  const url = `${API_BASE}member/${encodeURIComponent(auth.memberId)}/mall/crm/credits/bills?${buildQueryString(params)}`;

  log("准备查询: 最近积分明细");
  httpRequest("get", { url, headers: buildBusinessHeaders(false) }, function(error, response, data) {
    const result = parseBusinessResponse("积分明细查询", error, response, data);
    if (!result.ok) {
      callback(result.detail || result.message || "查询失败");
      return;
    }
    const bills = result.json && result.json.body;
    if (!Array.isArray(bills)) {
      callback("响应不是积分明细数组");
      return;
    }
    callback(null, bills);
  });
}

function executeLottery(config, session, lottery, callback) {
  const countParams = buildCommonParams(config, session, lottery, {
    mallId: lottery.mallId,
    currentPageType: lottery.currentPageType,
  });
  countParams.activityId = lottery.activityId;
  countParams.code = lottery.code;
  countParams.memberId = lottery.memberId;
  signRequestParams(countParams, "", config.wapKeys);
  const countUrl = `${API_BASE}prizesactivity/member/remain/count?${buildQueryString(countParams)}`;

  log("准备执行: 抽奖 | 先查询剩余次数");
  httpRequest(
    "get",
    {
      url: countUrl,
      headers: buildBusinessHeaders(true),
    },
    function(countError, countResponse, countData) {
      const countResult = parseBusinessResponse("抽奖次数查询", countError, countResponse, countData);
      if (!countResult.ok) {
        countResult.actionName = "抽奖";
        countResult.title = "汇融抽奖";
        delete countResult.json;
        callback(countResult);
        return;
      }

      const remaining = Number(
        countResult.json &&
        countResult.json.body &&
        countResult.json.body.remainningCount
      );
      if (!Number.isFinite(remaining) || remaining <= 0) {
        callback({
          ok: true,
          actionName: "抽奖",
          title: "汇融抽奖",
          subtitle: "没有可用抽奖次数",
          detail: "本次未发起抽奖请求",
          pointsEarned: 0,
          drawPerformed: false,
        });
        return;
      }

      playLottery(config, session, lottery, remaining, callback);
    }
  );
}

function playLottery(config, session, lottery, remaining, callback) {
  const payload = {
    activityId: lottery.activityId,
    mallId: lottery.mallId,
    memberId: lottery.memberId,
  };
  const bodyText = JSON.stringify(payload);
  const params = buildCommonParams(config, session, lottery, {
    mallId: lottery.mallId,
    currentPageType: lottery.currentPageType,
  });
  signRequestParams(params, bodyText, config.wapKeys);
  const url = `${API_BASE}prizesactivity/code/${encodeURIComponent(lottery.code)}/play?${buildQueryString(params)}`;

  log(`抽奖剩余次数: ${remaining} | 发起抽奖`);
  httpRequest(
    "post",
    {
      url,
      headers: buildBusinessHeaders(true),
      body: bodyText,
    },
    function(error, response, data) {
      const result = parseBusinessResponse("抽奖", error, response, data);
      result.actionName = "抽奖";
      result.title = "汇融抽奖";
      if (result.ok) {
        const body = result.json && result.json.body;
        result.subtitle = "执行成功";
        result.pointsEarned = extractCreditPrize(body);
        result.drawPerformed = true;
        result.detail =
          (body && (body.description || body.prizeName || body.showName)) ||
          "抽奖完成";
      }
      delete result.json;
      callback(result);
    }
  );
}

function buildCommonParams(config, session, profile, overrides) {
  const options = overrides || {};
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    appKey: config.appKey,
    appVersion: config.version,
    clientAppName: "memberClient",
    clientType: (profile && profile.clientType) || "mini_weixin",
    currentPageType: options.currentPageType || (profile && profile.currentPageType) || "",
    deviceId: session.deviceId,
    mallId: options.mallId || (profile && profile.mallId) || "",
    model: (profile && profile.model) || "IOS",
    osVersion: `mobile-${config.version}`,
    rnd: generateMixed(30),
    timestamp,
    accessToken: session.accessToken,
  };
  if (options.appUid) {
    params.appUid = options.appUid;
  }
  if (options.sid) {
    params.sid = options.sid;
  }
  return params;
}

function signRequestParams(params, bodyText, wapKeys) {
  const signingParams = cloneObject(params);
  if (bodyText) {
    signingParams.body = bodyText;
  }
  const sortedKeys = Object.keys(signingParams).sort();
  const segments = [];
  sortedKeys.forEach(function(key) {
    if (!isBlank(signingParams[key])) {
      segments.push(`${key}=${signingParams[key]}`);
    }
  });
  const timestamp = Number(params.timestamp);
  const secret = wapKeys[((timestamp % 10) + 10) % 10];
  params.sign = sha256(segments.join("&") + secret);
  params.signType = "sha";
  return params;
}

function buildBusinessHeaders(isGame) {
  const headers = {
    "Content-Type": "application/json",
    EncryptBody: "false",
    "Mobcb-Encrypt": "false",
  };
  if (isGame) {
    headers.ApiRequestSource = "game";
  }
  return headers;
}

function parseBusinessResponse(name, error, response, data) {
  if (error) {
    return {
      ok: false,
      title: `汇融${name}`,
      subtitle: `${name}请求失败`,
      detail: String(error),
      message: String(error),
    };
  }

  const status = getStatusCode(response);
  const responseText = extractResponseText(response, data);
  const json = safeJsonParse(responseText);
  const message = getApiMessage(json);
  const code = json && (json.errorCode || json.status);
  log(`接口返回: ${name} | HTTP ${status || 0} | code=${code || "unknown"}`);

  if (status !== 200) {
    return {
      ok: false,
      title: `汇融${name}`,
      subtitle: `${name}返回 HTTP ${status || "未知状态"}`,
      detail: truncateText(message || buildResponseMetadata(response, responseText)),
      message,
      json,
    };
  }
  if (!json) {
    return {
      ok: false,
      title: `汇融${name}`,
      subtitle: `${name}返回不是 JSON`,
      detail: "请检查接口或客户端配置是否已更新",
      message: "返回不是 JSON",
    };
  }
  if (!isApiSuccess(json)) {
    return {
      ok: false,
      title: `汇融${name}`,
      subtitle: `${name}未成功`,
      detail: truncateText(message || `业务码 ${json.errorCode || "未知"}`),
      message: message || String(json.errorCode || ""),
      json,
    };
  }
  return {
    ok: true,
    title: `汇融${name}`,
    subtitle: "执行成功",
    detail: message || "请求成功",
    message,
    json,
  };
}

function httpRequest(method, request, callback) {
  if (typeof $httpClient === "undefined") {
    callback("Loon $httpClient 不可用");
    return;
  }
  const sender = $httpClient[String(method).toLowerCase()];
  if (typeof sender !== "function") {
    callback(`Loon 不支持 HTTP ${String(method).toUpperCase()}`);
    return;
  }
  const options = {
    url: request.url,
    headers: request.headers || {},
    timeout: TIMEOUT_MS,
    "auto-cookie": false,
  };
  if (typeof request.body !== "undefined") {
    options.body = request.body;
  }
  sender.call($httpClient, options, callback);
}

function isApiSuccess(json) {
  return Boolean(json && json.errorCode === "PUB-00000");
}

function getApiMessage(json) {
  if (!json || typeof json !== "object") {
    return "";
  }
  return String(
    json.errorMessage ||
    json.errorCodeMsg ||
    json.message ||
    json.error ||
    (json.body && (json.body.message || json.body.msg || json.body.description)) ||
    ""
  );
}

function buildApiError(prefix, response, json) {
  const status = getStatusCode(response);
  const message = getApiMessage(json);
  return `${prefix}: HTTP ${status || 0}${json && json.errorCode ? ` | ${json.errorCode}` : ""}${message ? ` | ${message}` : ""}`;
}

function isAlreadyCompleted(message, errorCode) {
  return (
    String(errorCode || "") === "MBR-00029" ||
    /已签到|重复签到|今日.*签/.test(String(message || ""))
  );
}

function isValidAuth(auth) {
  return Boolean(
    auth &&
    auth.sid &&
    auth.memberId &&
    auth.mallId &&
    auth.deviceId
  );
}

function hasIdentityChanged(previous, sid, memberId) {
  return Boolean(
    previous &&
    ((previous.sid && sid && String(previous.sid) !== String(sid)) ||
      (previous.memberId && memberId && String(previous.memberId) !== String(memberId)))
  );
}

function hasSameBusinessIdentity(auth, lottery) {
  return Boolean(
    auth &&
    lottery &&
    String(auth.memberId) === String(lottery.memberId) &&
    String(auth.mallId) === String(lottery.mallId)
  );
}

function isValidPublicClientConfig(config) {
  return Boolean(
    config &&
    config.cacheVersion === 1 &&
    config.appKey &&
    config.version &&
    config.sourceUrl &&
    Array.isArray(config.wapKeys) &&
    config.wapKeys.length === 10 &&
    !config.wapKeys.some(isBlank)
  );
}

function isValidLottery(lottery) {
  return Boolean(
    lottery &&
    lottery.activityId &&
    lottery.memberId &&
    lottery.mallId &&
    lottery.deviceId &&
    lottery.code
  );
}

function resolveWebUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (path.charAt(0) === "/") {
    return `https://bop.mobcb.com${path}`;
  }
  return `${WEB_INDEX_URL}${path.replace(/^\.\//, "")}`;
}

function buildQueryString(params) {
  return Object.keys(params)
    .sort()
    .filter(function(key) {
      return !isBlank(params[key]);
    })
    .map(function(key) {
      const value = String(params[key]);
      const encodedValue = encodeURIComponent(value).replace(/%2F/gi, "/");
      return `${encodeURIComponent(key)}=${encodedValue}`;
    })
    .join("&");
}

function getQueryObject(url) {
  const output = {};
  const question = String(url || "").indexOf("?");
  if (question < 0) {
    return output;
  }
  String(url).slice(question + 1).split("&").forEach(function(pair) {
    if (!pair) {
      return;
    }
    const separator = pair.indexOf("=");
    const rawKey = separator < 0 ? pair : pair.slice(0, separator);
    const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
    output[safeDecode(rawKey)] = safeDecode(rawValue);
  });
  return output;
}

function getUrlPath(url) {
  const withoutQuery = String(url || "").split("?", 1)[0];
  return withoutQuery.replace(/^https?:\/\/[^/]+/i, "");
}

function extractLotteryCode(path) {
  const match = String(path || "").match(/\/api\/v3\/prizesactivity\/code\/([^/]+)\/play$/i);
  return match ? safeDecode(match[1]) : "";
}

function parseArgument(raw) {
  const result = {};
  String(raw || "").split("&").forEach(function(pair) {
    if (!pair) {
      return;
    }
    const index = pair.indexOf("=");
    const key = index < 0 ? pair : pair.slice(0, index);
    const value = index < 0 ? "" : pair.slice(index + 1);
    result[safeDecode(key)] = safeDecode(value);
  });
  return result;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function normalizeBody(body) {
  if (typeof body === "string") {
    return body.trim();
  }
  if (body === null || typeof body === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(body);
  } catch (_) {
    return String(body);
  }
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

function readJSON(key) {
  if (typeof $persistentStore === "undefined") {
    return null;
  }
  const raw = $persistentStore.read(key);
  return raw ? safeJsonParse(raw) : null;
}

function writeJSON(key, value) {
  if (typeof $persistentStore === "undefined") {
    return false;
  }
  try {
    return $persistentStore.write(JSON.stringify(value), key);
  } catch (_) {
    return false;
  }
}

function clearLegacyTemporaryPackets() {
  if (typeof $persistentStore === "undefined") {
    return;
  }
  LEGACY_STORE_KEYS.forEach(function(key) {
    if ($persistentStore.read(key)) {
      $persistentStore.write("", key);
      log(`已清理旧版临时请求包: ${key}`);
    }
  });
}

function minimizeStoredAuth() {
  const auth = readJSON(STORE_KEYS.auth);
  if (!auth || typeof auth !== "object") {
    return;
  }
  if (
    !Object.prototype.hasOwnProperty.call(auth, "openId") &&
    !Object.prototype.hasOwnProperty.call(auth, "latitude") &&
    !Object.prototype.hasOwnProperty.call(auth, "longitude")
  ) {
    return;
  }
  writeJSON(STORE_KEYS.auth, {
    version: 3,
    sid: String(auth.sid || ""),
    memberId: String(auth.memberId || ""),
    mallId: String(auth.mallId || ""),
    deviceId: String(auth.deviceId || ""),
    clientType: String(auth.clientType || "mini_weixin"),
    model: String(auth.model || "IOS"),
    capturedAt: Number(auth.capturedAt) || Date.now(),
  });
  log("已移除旧版不再需要的 openId/定位存储");
}

function cloneObject(input) {
  const output = {};
  Object.keys(input || {}).forEach(function(key) {
    output[key] = input[key];
  });
  return output;
}

function getStatusCode(response) {
  if (!response) {
    return 0;
  }
  return Number(response.status || response.statusCode || 0);
}

function extractResponseText(response, data) {
  if (typeof data === "string") {
    return data;
  }
  if (response && typeof response.body === "string") {
    return response.body;
  }
  if (data && typeof data === "object") {
    try {
      return JSON.stringify(data);
    } catch (_) {
      return "";
    }
  }
  return "";
}

function buildResponseMetadata(response, responseText) {
  const headers = (response && response.headers) || {};
  let contentType = "unknown";
  Object.keys(headers).some(function(key) {
    if (String(key).toLowerCase() === "content-type") {
      contentType = String(headers[key]).split(";", 1)[0] || "unknown";
      return true;
    }
    return false;
  });
  return `服务端返回非 JSON | Content-Type ${contentType} | body ${String(responseText || "").length} 字节`;
}

function getCurrentMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const monthText = String(month).padStart(2, "0");
  return {
    start: `${year}-${monthText}-01 00:00:00`,
    end: `${year}-${monthText}-${String(lastDay).padStart(2, "0")} 23:59:59`,
  };
}

function formatCreditBill(bill) {
  const item = bill && typeof bill === "object" ? bill : {};
  const number = Number(item.amount);
  const amount = Number.isFinite(number) ? Math.abs(number) : String(item.amount || "未知");
  const prefix = String(item.type) === "1" ? "-" : "+";
  const reason = truncateText(String(item.reason || "积分变动").replace(/\s+/g, " "), 30);
  const time = truncateText(String(item.time || "").replace(/\s+/g, " "), 24);
  return `${prefix}${amount} ${reason}${time ? ` (${time})` : ""}`;
}

function summarizeTodayCredits(bills) {
  const dateKey = formatDateKey(new Date());
  const summary = {
    dateKey,
    signPoints: 0,
    lotteryPoints: 0,
    todayEarned: 0,
    hasSignCredit: false,
    hasLotteryCredit: false,
    latestBill: Array.isArray(bills) && bills.length ? formatCreditBill(bills[0]) : "",
  };
  (Array.isArray(bills) ? bills : []).forEach(function(bill) {
    const item = bill && typeof bill === "object" ? bill : {};
    const time = String(item.time || "");
    const amount = Math.abs(Number(item.amount));
    if (time.indexOf(dateKey) !== 0 || !Number.isFinite(amount) || String(item.type) === "1") {
      return;
    }
    const reason = String(item.reason || "");
    summary.todayEarned += amount;
    if (/签到/.test(reason)) {
      summary.signPoints += amount;
      summary.hasSignCredit = true;
    }
    if (/大转盘|转盘|抽奖/.test(reason)) {
      summary.lotteryPoints += amount;
      summary.hasLotteryCredit = true;
    }
  });
  summary.signPoints = roundPoints(summary.signPoints);
  summary.lotteryPoints = roundPoints(summary.lotteryPoints);
  summary.todayEarned = roundPoints(summary.todayEarned);
  return summary;
}

function extractCreditPrize(body) {
  if (!body || String(body.prizeType || "").toLowerCase() !== "credit") {
    return 0;
  }
  const text = [body.prizeName, body.showName, body.description].filter(Boolean).join(" ");
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function formatDateKey(date) {
  const value = date || new Date();
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function roundPoints(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatPoints(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "未查到";
  }
  return `${number >= 0 ? "+" : ""}${roundPoints(number)}`;
}

function generateMixed(length) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet.charAt(randomByte() % alphabet.length);
  }
  return output;
}

function randomByte() {
  try {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(1);
      crypto.getRandomValues(bytes);
      return bytes[0];
    }
  } catch (_) {}
  return Math.floor(Math.random() * 256);
}

function rsaEncryptLong(text, publicKey) {
  const key = parseRsaPublicKey(publicKey);
  const bytes = utf8Bytes(text);
  const blockSize = key.size - 11;
  if (blockSize <= 0) {
    throw new Error("RSA 公钥长度无效");
  }
  const encrypted = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.slice(offset, offset + blockSize);
    const padded = pkcs1Pad(block, key.size);
    const value = bytesToBigInt(padded);
    const cipher = modPow(value, key.exponent, key.modulus);
    encrypted.push.apply(encrypted, bigIntToBytes(cipher, key.size));
  }
  return bytesToBase64(encrypted);
}

function parseRsaPublicKey(publicKey) {
  const clean = String(publicKey || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(clean);

  for (let index = 0; index < der.length - 8; index += 1) {
    if (der[index] !== 0x02) {
      continue;
    }
    const first = readDerValue(der, index);
    if (!first || first.value.length < 64) {
      continue;
    }
    const second = readDerValue(der, first.next);
    if (!second || der[first.next] !== 0x02 || second.value.length > 8) {
      continue;
    }
    const modulusBytes = stripLeadingZero(first.value);
    return {
      modulus: bytesToBigInt(modulusBytes),
      exponent: bytesToBigInt(stripLeadingZero(second.value)),
      size: modulusBytes.length,
    };
  }
  throw new Error("无法解析服务端 RSA 公钥");
}

function readDerValue(bytes, tagIndex) {
  if (tagIndex + 2 > bytes.length) {
    return null;
  }
  let cursor = tagIndex + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || cursor + count > bytes.length) {
      return null;
    }
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = (length * 256) + bytes[cursor++];
    }
  }
  if (cursor + length > bytes.length) {
    return null;
  }
  return {
    value: bytes.slice(cursor, cursor + length),
    next: cursor + length,
  };
}

function stripLeadingZero(bytes) {
  let index = 0;
  while (index < bytes.length - 1 && bytes[index] === 0) {
    index += 1;
  }
  return bytes.slice(index);
}

function pkcs1Pad(message, size) {
  if (message.length > size - 11) {
    throw new Error("RSA 明文分块过长");
  }
  const output = [0, 2];
  const paddingLength = size - message.length - 3;
  for (let index = 0; index < paddingLength; index += 1) {
    let value = 0;
    while (value === 0) {
      value = randomByte();
    }
    output.push(value);
  }
  output.push(0);
  return output.concat(message);
}

function modPow(base, exponent, modulus) {
  let result = BigInt(1);
  let value = base % modulus;
  let power = exponent;
  const zero = BigInt(0);
  const one = BigInt(1);
  const two = BigInt(2);
  while (power > zero) {
    if (power % two === one) {
      result = (result * value) % modulus;
    }
    power = power / two;
    value = (value * value) % modulus;
  }
  return result;
}

function bytesToBigInt(bytes) {
  const hex = bytes.map(function(value) {
    return value.toString(16).padStart(2, "0");
  }).join("");
  return BigInt(`0x${hex || "0"}`);
}

function bigIntToBytes(value, size) {
  let hex = value.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  hex = hex.padStart(size * 2, "0");
  const output = [];
  for (let index = 0; index < hex.length; index += 2) {
    output.push(parseInt(hex.slice(index, index + 2), 16));
  }
  return output;
}

function generateEphemeralClientPublicKey() {
  const modulus = [];
  for (let index = 0; index < 128; index += 1) {
    modulus.push(randomByte());
  }
  modulus[0] |= 0x80;
  modulus[modulus.length - 1] |= 1;
  const rsaPublicKey = derSequence([
    derInteger(modulus),
    derInteger([0x01, 0x00, 0x01]),
  ]);
  const algorithmIdentifier = hexToBytes("300d06092a864886f70d0101010500");
  const subjectPublicKeyInfo = derSequence([
    algorithmIdentifier,
    derValue(0x03, [0].concat(rsaPublicKey)),
  ]);
  return bytesToBase64(subjectPublicKeyInfo);
}

function derInteger(bytes) {
  let value = stripLeadingZero(bytes.slice());
  if (value[0] & 0x80) {
    value = [0].concat(value);
  }
  return derValue(0x02, value);
}

function derSequence(parts) {
  const body = [];
  parts.forEach(function(part) {
    body.push.apply(body, part);
  });
  return derValue(0x30, body);
}

function derValue(tag, value) {
  return [tag].concat(derLength(value.length), value);
}

function derLength(length) {
  if (length < 128) {
    return [length];
  }
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return [0x80 | bytes.length].concat(bytes);
}

function base64ToBytes(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(value || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const output = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean.charAt(index);
    if (character === "=") {
      break;
    }
    const number = alphabet.indexOf(character);
    if (number < 0) {
      continue;
    }
    buffer = (buffer << 6) | number;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function bytesToBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet.charAt((value >> 18) & 63);
    output += alphabet.charAt((value >> 12) & 63);
    output += index + 1 < bytes.length ? alphabet.charAt((value >> 6) & 63) : "=";
    output += index + 2 < bytes.length ? alphabet.charAt(value & 63) : "=";
  }
  return output;
}

function hexToBytes(hex) {
  const output = [];
  for (let index = 0; index < hex.length; index += 2) {
    output.push(parseInt(hex.slice(index, index + 2), 16));
  }
  return output;
}

function utf8Bytes(text) {
  const encoded = unescape(encodeURIComponent(String(text)));
  const output = [];
  for (let index = 0; index < encoded.length; index += 1) {
    output.push(encoded.charCodeAt(index));
  }
  return output;
}

function sha256(text) {
  const bytes = utf8Bytes(text);
  const words = [];
  const bitLength = bytes.length * 8;
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] = (words[index >> 2] || 0) | (bytes[index] << (24 - (index % 4) * 8));
  }
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (24 - bitLength % 32));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;

  const initial = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = initial.slice();
  const schedule = new Array(64);

  for (let offset = 0; offset < words.length; offset += 16) {
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) {
        schedule[index] = words[offset + index] | 0;
      } else {
        const x = schedule[index - 15];
        const y = schedule[index - 2];
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
      }
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + schedule[index]) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  return hash.map(function(value) {
    return (value >>> 0).toString(16).padStart(8, "0");
  }).join("");
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function notify(title, subtitle, message) {
  setRuntimeMessage([title, subtitle, message].filter(Boolean).join("\n"));
  printMessage(runtimeState.lastMessage);
  if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
    $notification.post(title, subtitle || "", message || "");
  }
}

function notifyAllResults(results, creditSummary) {
  const summary = creditSummary || {};
  const signResult = findActionResult(results, "签到");
  const lotteryResult = findActionResult(results, "抽奖");
  const directSignPoints = getResultPoints(signResult);
  const directLotteryPoints = getResultPoints(lotteryResult);
  const signPoints = summary.hasSignCredit ? summary.signPoints : directSignPoints;
  const lotteryPoints = summary.hasLotteryCredit ? summary.lotteryPoints : directLotteryPoints;
  const taskPoints =
    (Number.isFinite(signPoints) ? signPoints : 0) +
    (Number.isFinite(lotteryPoints) ? lotteryPoints : 0);
  const lines = [
    "╭──── 汇融每日任务 ────╮",
    `│ 📅 日期：${summary.dateKey || formatDateKey(new Date())}`,
    "├───────────────────┤",
    `│ ${formatTaskIcon(signResult, "sign")} 签到状态：${formatTaskStatus(signResult, "sign")}`,
    `│    今日签到积分：${formatPoints(signPoints)}`,
    `│ ${formatTaskIcon(lotteryResult, "lottery")} 抽奖状态：${formatTaskStatus(lotteryResult, "lottery")}`,
    `│    今日抽奖积分：${formatPoints(lotteryPoints)}`,
    "├───────────────────┤",
    `│ 📈 任务积分：${formatPoints(taskPoints)}`,
    `│ 💰 当前总计：${isBlank(summary.totalCredit) ? "查询失败" : summary.totalCredit}`,
    `│ 🧾 最近记录：${summary.latestBill || (summary.billsError ? "查询失败" : "暂无记录")}`,
    "╰───────────────────╯",
  ];
  const report = lines.join("\n");
  setRuntimeMessage(report);
  printMessage(report);
  if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
    $notification.post("汇融每日任务", formatNotificationStatus(signResult, lotteryResult), report);
  }
}

function findActionResult(results, actionName) {
  const list = Array.isArray(results) ? results : [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] && list[index].actionName === actionName) {
      return list[index];
    }
  }
  return null;
}

function getResultPoints(result) {
  if (!result || !Number.isFinite(Number(result.pointsEarned))) {
    return NaN;
  }
  return Number(result.pointsEarned);
}

function formatTaskIcon(result, type) {
  if (!result || !result.ok) {
    return "❌";
  }
  if (type === "lottery" && result.drawPerformed === false) {
    return "⏭";
  }
  return "✅";
}

function formatNotificationStatus(signResult, lotteryResult) {
  const signStatus = !signResult
    ? "未执行"
    : !signResult.ok
      ? "失败"
      : signResult.subtitle === "今日已签到" ? "今日已签" : "成功";
  const lotteryStatus = !lotteryResult
    ? "未执行"
    : !lotteryResult.ok
      ? "失败"
      : lotteryResult.drawPerformed === false ? "无次数" : "成功";
  return `签到：${signStatus} · 抽奖：${lotteryStatus}`;
}

function formatTaskStatus(result, type) {
  if (!result) {
    return "未执行";
  }
  if (!result.ok) {
    return truncateText(`失败 · ${result.subtitle || result.detail || "未知错误"}`, 42);
  }
  if (type === "sign") {
    if (result.subtitle === "今日已签到") {
      return "今日已签到";
    }
    return result.continuousDays
      ? `签到成功 · 连续 ${result.continuousDays} 天`
      : "签到成功";
  }
  if (result.subtitle === "没有可用抽奖次数") {
    return "无可用次数";
  }
  return truncateText(result.detail || result.subtitle || "抽奖完成", 34);
}

function finish(message, silent, detail) {
  if (!silent) {
    notify("汇融任务", message, truncateText(detail || ""));
  }
  done();
}

function done(value) {
  if (runtimeState.completed) {
    return;
  }
  runtimeState.completed = true;
  releaseLock();
  if (typeof $done === "function") {
    if (typeof value !== "undefined") {
      $done(value);
      return;
    }
    if (hasHttpRequest()) {
      $done({});
      return;
    }
    $done(runtimeState.lastMessage ? { body: truncateText(runtimeState.lastMessage, 900) } : {});
  }
}

function isBlank(value) {
  return value === "" || value === null || typeof value === "undefined";
}

function maskValue(value, head, tail) {
  const text = String(value || "");
  if (text.length <= head + tail) {
    return "***";
  }
  return `${text.slice(0, head)}***${text.slice(text.length - tail)}`;
}

function truncateText(text, limit) {
  const content = String(text || "");
  const max = limit || MAX_NOTIFICATION_DETAIL;
  return content.length <= max ? content : `${content.slice(0, max - 3)}...`;
}

function delay(ms, callback) {
  if (typeof setTimeout === "function" && ms > 0) {
    setTimeout(callback, ms);
    return;
  }
  callback();
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function setRuntimeMessage(message) {
  runtimeState.lastMessage = truncateText(message || "", 900);
}

function log(message) {
  if (!runtimeState.debug) {
    return;
  }
  printMessage(message);
}

function printMessage(message) {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log(`[${SCRIPT_NAME}] ${message}`);
  }
}

function isDebugEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function acquireLock(action) {
  if (typeof $persistentStore === "undefined") {
    return true;
  }
  const now = Date.now();
  const current = readJSON(STORE_KEYS.lock);
  if (
    current &&
    current.runId &&
    Number(current.expiresAt) > now &&
    current.runId !== runtimeState.runId
  ) {
    return false;
  }
  const ok = writeJSON(STORE_KEYS.lock, {
    runId: runtimeState.runId,
    action,
    expiresAt: now + LOCK_TTL_MS,
  });
  runtimeState.lockAcquired = Boolean(ok);
  return ok;
}

function releaseLock() {
  if (!runtimeState.lockAcquired || typeof $persistentStore === "undefined") {
    return;
  }
  const current = readJSON(STORE_KEYS.lock);
  if (current && current.runId === runtimeState.runId) {
    $persistentStore.write("", STORE_KEYS.lock);
  }
  runtimeState.lockAcquired = false;
}
