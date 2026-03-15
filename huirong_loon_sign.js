/*
 * Huirong check-in and lottery script for Loon.
 *
 * Loon plugin URL:
 * https://raw.githubusercontent.com/doosit/huirong/refs/heads/main/huirong.plugin
 *
 * Raw script URL:
 * https://raw.githubusercontent.com/doosit/huirong/refs/heads/main/huirong_loon_sign.js
 *
 * Other examples:
 * cron "0 8 * * *" script-path=/path/to/huirong_loon_sign.js,tag=HuirongSignCron,timeout=60,argument="action=sign"
 * cron "5 8 * * *" script-path=/path/to/huirong_loon_sign.js,tag=HuirongLotteryCron,timeout=60,argument="action=lottery"
 * cron "0 8 * * *" script-path=/path/to/huirong_loon_sign.js,tag=HuirongDailyCron,timeout=120,argument="action=all"
 *
 * How it works:
 * 1. Use the http-request rules to capture one successful manual sign-in request and one lottery request.
 * 2. The script stores the full request URL, headers, and body in Loon persistent storage.
 * 3. The cron task replays the captured requests automatically.
 *
 * Important:
 * - This app uses dynamic parameters such as timestamp/rnd/sign.
 * - Without the signing algorithm, the script can only replay the latest captured request.
 * - If the server later rejects the request because the signature expired, open the app and perform
 *   the corresponding action manually once to refresh the stored packet.
 */

const ACTIONS = {
  sign: {
    name: "签到",
    storeKey: "huirong.loon.action.sign",
    urlPattern: /^https:\/\/bop\.mobcb\.com\/api\/v3\/report\/member\/location\b/i,
    expectedMethod: "POST",
    requiredQueryFields: ["accessToken", "timestamp", "rnd", "sign", "signType", "mallId"],
    requiredBodyFields: ["openId", "latitude", "longitude", "mallId"],
    isSuccess(json) {
      return (
        json &&
        json.errorCode === "PUB-00000" &&
        json.body &&
        json.body.result === "success"
      );
    },
    successMessage(json) {
      if (json && json.body && json.body.success) {
        return json.body.success;
      }
      return "请求成功";
    },
  },
  lottery: {
    name: "抽奖",
    storeKey: "huirong.loon.action.lottery",
    urlPattern: /^https:\/\/bop\.mobcb\.com\/api\/v3\/prizesactivity\/code\/bigWheel\/play\b/i,
    expectedMethod: "POST",
    requiredQueryFields: ["accessToken", "timestamp", "rnd", "sign", "signType", "mallId"],
    requiredBodyFields: ["activityId", "mallId", "memberId"],
    isSuccess(json) {
      return json && json.errorCode === "PUB-00000" && json.body;
    },
    successMessage(json) {
      const body = json && json.body ? json.body : null;
      if (!body) {
        return "请求成功";
      }
      if (body.description) {
        return body.description;
      }
      if (body.prizeName) {
        return `获得 ${body.prizeName}`;
      }
      if (typeof body.winningStatus !== "undefined") {
        return `抽奖完成，状态 ${body.winningStatus}`;
      }
      return "请求成功";
    },
  },
};

const ACTION_ORDER = ["sign", "lottery"];
const DEFAULT_ACTION = "sign";
const TIMEOUT_MS = 20000;
const LOCK_KEY = "huirong.loon.runtime.lock";
const LOCK_TTL_MS = 2 * 60 * 1000;
const INTER_ACTION_DELAY_MS = 1500;
const MAX_NOTIFICATION_DETAIL = 240;
const runtimeState = {
  runId: createRunId(),
  lockAcquired: false,
  completed: false,
};

main();

function main() {
  const args = parseArgument(typeof $argument === "string" ? $argument : "");
  const detectedActionKey = detectActionFromRequest();
  const actionKey = args.action || detectedActionKey || DEFAULT_ACTION;

  if (typeof $request !== "undefined") {
    const action = ACTIONS[detectedActionKey || actionKey];
    if (!action) {
      finish(`未识别的 action: ${actionKey}`);
      return;
    }
    captureRequest(action);
    return;
  }

  if (!acquireLock(actionKey)) {
    finish("检测到脚本已在运行", false, "为避免重复签到或重复抽奖，本次执行已跳过");
    return;
  }

  if (actionKey === "all") {
    replayAllActions();
    return;
  }

  const action = ACTIONS[actionKey];
  if (!action) {
    finish(`未识别的 action: ${actionKey}`);
    return;
  }

  replayRequest(action);
}

function detectActionFromRequest() {
  if (typeof $request === "undefined" || !$request || !$request.url) {
    return "";
  }

  const url = $request.url;
  for (const key of Object.keys(ACTIONS)) {
    if (ACTIONS[key].urlPattern.test(url)) {
      return key;
    }
  }
  return "";
}

function captureRequest(action) {
  const request = $request || {};
  const url = request.url || "";
  const method = (request.method || "GET").toUpperCase();
  const bodyText = normalizeBody(request.body);
  const bodyJson = safeJsonParse(bodyText);

  if (!action.urlPattern.test(url)) {
    finish(`当前请求不是${action.name}接口，已跳过`, true);
    return;
  }

  const payload = {
    action: action.name,
    url,
    method,
    headers: normalizeHeaders(request.headers || {}),
    body: bodyText,
    capturedAt: Date.now(),
  };

  if (action.expectedMethod && method !== action.expectedMethod) {
    finish(`已匹配到接口，但请求方法不是 ${action.expectedMethod}`);
    return;
  }

  if (method !== "GET" && !bodyText) {
    finish(`已捕获${action.name}请求，但请求体为空`, false, "请确认 Loon 规则带有 requires-body=true");
    return;
  }

  const queryError = validateQueryFields(action, url);
  if (queryError) {
    finish(`已捕获${action.name}请求，但 URL 参数不完整`, false, queryError);
    return;
  }

  const bodyError = validateBodyFields(action, bodyJson, bodyText);
  if (bodyError) {
    finish(`已捕获${action.name}请求，但请求体校验失败`, false, bodyError);
    return;
  }

  const ok = writeJSON(action.storeKey, payload);
  if (!ok) {
    finish(`保存${action.name}请求失败`);
    return;
  }

  const detail = `方法: ${payload.method} | 已保存最新请求 | ${buildCaptureSummary(action, url, bodyJson)}`;
  notify(`汇融${action.name}`, "抓包保存成功", detail);
  done({});
}

function replayRequest(action) {
  executeAction(action, function(result) {
    notifyResult(result);
    done();
  });
}

function replayAllActions() {
  const results = [];
  runActionQueue(0, results);
}

function runActionQueue(index, results) {
  if (index >= ACTION_ORDER.length) {
    notifyAllResults(results);
    done();
    return;
  }

  const actionKey = ACTION_ORDER[index];
  const action = ACTIONS[actionKey];
  if (!action) {
    runActionQueue(index + 1, results);
    return;
  }

  executeAction(action, function(result) {
    results.push(result);
    delay(INTER_ACTION_DELAY_MS, function() {
      runActionQueue(index + 1, results);
    });
  });
}

function executeAction(action, callback) {
  const saved = readJSON(action.storeKey);
  if (!saved) {
    callback({
      ok: false,
      actionName: action.name,
      title: `汇融${action.name}`,
      subtitle: `没有找到已保存的${action.name}请求`,
      detail: "请先手动触发一次抓包",
    });
    return;
  }

  const payloadError = validateSavedPayload(action, saved);
  if (payloadError) {
    callback({
      ok: false,
      actionName: action.name,
      title: `汇融${action.name}`,
      subtitle: `${action.name}抓包数据无效`,
      detail: payloadError,
    });
    return;
  }

  const requestOptions = {
    url: saved.url,
    headers: cloneHeaders(saved.headers || {}),
    timeout: TIMEOUT_MS,
  };

  if ((saved.method || action.expectedMethod || "GET").toUpperCase() !== "GET") {
    requestOptions.body = saved.body || "";
  }

  const method = (saved.method || action.expectedMethod || "GET").toLowerCase();
  const sender = resolveSender(method);

  if (!sender) {
    callback({
      ok: false,
      actionName: action.name,
      title: `汇融${action.name}`,
      subtitle: `不支持的请求方法: ${saved.method}`,
      detail: "",
    });
    return;
  }

  sender(requestOptions, function(error, response, data) {
    if (error) {
      callback({
        ok: false,
        actionName: action.name,
        title: `汇融${action.name}`,
        subtitle: `${action.name}请求失败: ${String(error)}`,
        detail: buildRecaptureHint(saved),
      });
      return;
    }

    const responseText = extractResponseText(response, data);
    const status = getStatusCode(response);
    const json = safeJsonParse(responseText);
    if (status !== 200) {
      callback({
        ok: false,
        actionName: action.name,
        title: `汇融${action.name}`,
        subtitle: `${action.name}请求返回 HTTP ${status || "未知状态"}`,
        detail: truncateText(responseText) || buildRecaptureHint(saved),
      });
      return;
    }

    if (!json) {
      callback({
        ok: false,
        actionName: action.name,
        title: `汇融${action.name}`,
        subtitle: `${action.name}返回不是 JSON`,
        detail: truncateText(responseText) || buildRecaptureHint(saved),
      });
      return;
    }

    if (action.isSuccess(json)) {
      const age = saved.capturedAt ? formatAge(saved.capturedAt) : "未知";
      callback({
        ok: true,
        actionName: action.name,
        title: `汇融${action.name}`,
        subtitle: "执行成功",
        detail: truncateText(`${action.successMessage(json)} | 抓包时间: ${age}`),
      });
      return;
    }

    const message =
      json.errorMessage ||
      (json.body && (json.body.message || json.body.msg || json.body.result)) ||
      "服务端未返回成功结果";
    callback({
      ok: false,
      actionName: action.name,
      title: `汇融${action.name}`,
      subtitle: `${action.name}未成功: ${message}`,
      detail: buildRecaptureHint(saved),
    });
  });
}

function resolveSender(method) {
  if (typeof $httpClient === "undefined") {
    return null;
  }

  if (method === "post" && typeof $httpClient.post === "function") {
    return $httpClient.post.bind($httpClient);
  }
  if (method === "get" && typeof $httpClient.get === "function") {
    return $httpClient.get.bind($httpClient);
  }
  if (method === "put" && typeof $httpClient.put === "function") {
    return $httpClient.put.bind($httpClient);
  }
  if (method === "delete" && typeof $httpClient.delete === "function") {
    return $httpClient.delete.bind($httpClient);
  }
  return null;
}

function validateSavedPayload(action, saved) {
  if (!saved || typeof saved !== "object") {
    return "本地存储为空或已损坏，请重新抓包";
  }
  if (!saved.url || !action.urlPattern.test(saved.url)) {
    return "保存的 URL 不匹配当前接口，请重新抓包";
  }
  const method = String(saved.method || "").toUpperCase();
  if (!method) {
    return "保存的请求方法为空，请重新抓包";
  }
  if (action.expectedMethod && method !== action.expectedMethod) {
    return `保存的请求方法为 ${method}，预期为 ${action.expectedMethod}`;
  }
  const queryError = validateQueryFields(action, saved.url);
  if (queryError) {
    return queryError;
  }
  const bodyError = validateBodyFields(action, safeJsonParse(saved.body), saved.body);
  if (bodyError) {
    return bodyError;
  }
  return "";
}

function validateQueryFields(action, url) {
  const query = getQueryObject(url);
  const missing = (action.requiredQueryFields || []).filter(function(field) {
    return isBlank(query[field]);
  });
  if (missing.length) {
    return `缺少参数: ${missing.join(", ")}`;
  }
  return "";
}

function validateBodyFields(action, bodyJson, bodyText) {
  const method = String(action.expectedMethod || "GET").toUpperCase();
  if (method === "GET") {
    return "";
  }
  if (!bodyText) {
    return "请求体为空，请重新抓包并确认 requires-body=true";
  }
  if (!bodyJson || typeof bodyJson !== "object") {
    return "请求体不是有效 JSON，请重新抓包";
  }
  const missing = (action.requiredBodyFields || []).filter(function(field) {
    return typeof bodyJson[field] === "undefined" || bodyJson[field] === null || bodyJson[field] === "";
  });
  if (missing.length) {
    return `请求体缺少字段: ${missing.join(", ")}`;
  }
  return "";
}

function normalizeHeaders(headers) {
  const skip = {
    host: true,
    connection: true,
    "content-length": true,
    "accept-encoding": true,
    priority: true,
    te: true,
    trailer: true,
  };

  const result = {};
  Object.keys(headers || {}).forEach(function(key) {
    if (!key) {
      return;
    }
    const lowerKey = String(key).toLowerCase();
    if (lowerKey.charAt(0) === ":") {
      return;
    }
    if (
      lowerKey.indexOf("sec-fetch-") === 0 ||
      lowerKey.indexOf("proxy-") === 0
    ) {
      return;
    }
    if (skip[lowerKey]) {
      return;
    }
    result[key] = String(headers[key]);
  });
  return result;
}

function cloneHeaders(headers) {
  const output = {};
  Object.keys(headers || {}).forEach(function(key) {
    output[key] = headers[key];
  });
  return output;
}

function normalizeBody(body) {
  if (typeof body === "string") {
    return body.trim();
  }
  if (typeof body === "undefined" || body === null) {
    return "";
  }
  try {
    return JSON.stringify(body);
  } catch (e) {
    return String(body);
  }
}

function hasSignatureFields(url) {
  const query = getQueryObject(url);
  return Boolean(query.accessToken && query.timestamp && query.sign);
}

function getQueryObject(url) {
  const output = {};
  const pos = url.indexOf("?");
  if (pos === -1) {
    return output;
  }
  const queryString = url.slice(pos + 1);
  queryString.split("&").forEach(function(pair) {
    if (!pair) {
      return;
    }
    const index = pair.indexOf("=");
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const rawValue = index === -1 ? "" : pair.slice(index + 1);
    const key = safeDecode(rawKey);
    output[key] = safeDecode(rawValue);
  });
  return output;
}

function parseArgument(raw) {
  const result = {};
  if (!raw) {
    return result;
  }

  raw.split("&").forEach(function(pair) {
    if (!pair) {
      return;
    }
    const index = pair.indexOf("=");
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? "" : pair.slice(index + 1);
    result[safeDecode(key)] = safeDecode(value);
  });
  return result;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function readJSON(key) {
  if (typeof $persistentStore === "undefined") {
    return null;
  }
  const raw = $persistentStore.read(key);
  if (!raw) {
    return null;
  }
  return safeJsonParse(raw);
}

function writeJSON(key, value) {
  if (typeof $persistentStore === "undefined") {
    return false;
  }
  try {
    return $persistentStore.write(JSON.stringify(value), key);
  } catch (e) {
    return false;
  }
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }
  if (typeof text === "object") {
    return text;
  }
  if (typeof text !== "string") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function formatAge(timestamp) {
  const diffMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "未知";
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return `${diffSec} 秒前`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour} 小时前`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

function notify(title, subtitle, message) {
  if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
    $notification.post(title, subtitle || "", message || "");
  }
}

function notifyResult(result) {
  notify(result.title, result.subtitle, truncateText(result.detail));
}

function notifyAllResults(results) {
  const okCount = results.filter(function(item) {
    return item && item.ok;
  }).length;
  const lines = results.map(function(item) {
    if (!item) {
      return "未知任务: 未执行";
    }
    const summary = item.ok ? item.detail : `${item.subtitle}${item.detail ? ` (${item.detail})` : ""}`;
    return `${item.actionName}: ${truncateText(summary, 80)}`;
  });
  notify("汇融任务", `成功 ${okCount} 项 / 共 ${results.length} 项`, truncateText(lines.join(" | ")));
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
    if (typeof $request !== "undefined" || typeof $response !== "undefined") {
      $done({});
      return;
    }
    $done();
  }
}

function extractResponseText(response, data) {
  if (typeof data === "string") {
    return data;
  }
  if (response && typeof response.body === "string") {
    return response.body;
  }
  if (typeof data === "object" && data !== null) {
    try {
      return JSON.stringify(data);
    } catch (e) {
      return String(data);
    }
  }
  return "";
}

function getStatusCode(response) {
  if (!response) {
    return 0;
  }
  const raw = response.status || response.statusCode;
  return raw ? Number(raw) : 0;
}

function buildCaptureSummary(action, url, bodyJson) {
  const parts = [];
  const query = getQueryObject(url);
  if (query.mallId) {
    parts.push(`mallId=${query.mallId}`);
  }
  if (action === ACTIONS.lottery && bodyJson && bodyJson.activityId) {
    parts.push(`activityId=${bodyJson.activityId}`);
  }
  if (action === ACTIONS.sign && bodyJson && bodyJson.openId) {
    parts.push(`openId=${maskValue(bodyJson.openId, 4, 4)}`);
  }
  return parts.join(" | ") || "关键参数已保存";
}

function buildRecaptureHint(saved) {
  const age = saved && saved.capturedAt ? formatAge(saved.capturedAt) : "未知";
  return truncateText(`当前使用的抓包时间: ${age}，如果提示签名或时间戳失效，请重新手动执行一次并刷新抓包`);
}

function truncateText(text, limit) {
  const content = typeof text === "string" ? text : text ? String(text) : "";
  const max = limit || MAX_NOTIFICATION_DETAIL;
  if (!content || content.length <= max) {
    return content;
  }
  return `${content.slice(0, max - 3)}...`;
}

function isBlank(value) {
  return typeof value === "undefined" || value === null || value === "";
}

function maskValue(value, head, tail) {
  const text = value ? String(value) : "";
  if (!text || text.length <= (head || 0) + (tail || 0)) {
    return text;
  }
  return `${text.slice(0, head || 0)}***${text.slice(text.length - (tail || 0))}`;
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

function acquireLock(actionKey) {
  if (typeof $persistentStore === "undefined") {
    return true;
  }
  const now = Date.now();
  const current = readJSON(LOCK_KEY);
  if (
    current &&
    current.runId &&
    current.expiresAt &&
    Number(current.expiresAt) > now &&
    current.runId !== runtimeState.runId
  ) {
    return false;
  }
  const lock = {
    runId: runtimeState.runId,
    action: actionKey,
    expiresAt: now + LOCK_TTL_MS,
    createdAt: now,
  };
  const ok = writeJSON(LOCK_KEY, lock);
  runtimeState.lockAcquired = Boolean(ok);
  return ok;
}

function releaseLock() {
  if (!runtimeState.lockAcquired || typeof $persistentStore === "undefined") {
    return;
  }
  const current = readJSON(LOCK_KEY);
  if (current && current.runId === runtimeState.runId) {
    $persistentStore.write("", LOCK_KEY);
  }
  runtimeState.lockAcquired = false;
}
