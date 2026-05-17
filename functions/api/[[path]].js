const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 500;

export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = getPath(params);

  try {
    if (method === "GET" && path === "health") {
      assertDb(env);

      return jsonResponse({
        ok: true,
        message: "接口正常，D1 已绑定",
        time: getNowTime()
      });
    }

    if (method === "GET" && path === "messages") {
      return await handleGetMessages(env);
    }

    if (method === "POST" && path === "send") {
      return await handleSendMessage(request, env);
    }

    if (method === "POST" && path === "reply") {
      return await handleParentReply(request, env);
    }
    if (method === "POST" && path === "clear") {
    return await handleClearMessages(env);
    }

    return jsonResponse(
      {
        ok: false,
        message: "接口不存在",
        path,
        url: url.pathname
      },
      404
    );
  } catch (err) {
    console.error("API error:", err);

    return jsonResponse(
      {
        ok: false,
        message: err && err.message ? err.message : "服务器错误"
      },
      500
    );
  }
}

async function handleGetMessages(env) {
  assertDb(env);

  const result = await env.DB.prepare(
    `
    SELECT
      id,
      from_type,
      content,
      channel,
      created_at,
      wxpusher_status,
      wxpusher_response,
      dingtalk_status,
      dingtalk_response
    FROM messages
    ORDER BY created_at DESC
    LIMIT ?
    `
  )
    .bind(MAX_MESSAGES)
    .all();

  const rows = Array.isArray(result.results) ? result.results : [];

  const messages = rows
    .map(row => {
      return {
        id: row.id,
        from: row.from_type || "system",
        text: row.content || "",
        time: formatDisplayTime(row.created_at),
        createdAt: new Date(row.created_at).getTime(),
        channel: row.channel || "",
        wxpusherStatus: row.wxpusher_status || "",
        dingtalkStatus: row.dingtalk_status || ""
      };
    })
    .reverse();

  return jsonResponse({
    ok: true,
    messages
  });
}

async function handleSendMessage(request, env) {
  assertDb(env);

  const body = await readJson(request);
  const message = String(body.message || "").trim();

  if (!message) {
    return jsonResponse(
      {
        ok: false,
        message: "消息不能为空"
      },
      400
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse(
      {
        ok: false,
        message: `消息太长了，最多 ${MAX_MESSAGE_LENGTH} 个字符`
      },
      400
    );
  }

  const id = createId();
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO messages (
      id,
      from_type,
      content,
      channel,
      created_at,
      wxpusher_status,
      wxpusher_response,
      dingtalk_status,
      dingtalk_response
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      "me",
      message,
      "all",
      nowIso,
      "pending",
      "",
      "pending",
      ""
    )
    .run();

  const pushText = buildPushText(message);

  const results = await Promise.allSettled([
    sendWxPusher(env, pushText, message),
    sendDingTalk(env, pushText)
  ]);

  const wxpusherResult = normalizeSettledResult(results[0]);
  const dingtalkResult = normalizeSettledResult(results[1]);

  const wxpusherStatus = wxpusherResult.ok
    ? "sent"
    : wxpusherResult.skipped
      ? "skipped"
      : "failed";

  const dingtalkStatus = dingtalkResult.ok
    ? "sent"
    : dingtalkResult.skipped
      ? "skipped"
      : "failed";

  await env.DB.prepare(
    `
    UPDATE messages
    SET
      wxpusher_status = ?,
      wxpusher_response = ?,
      dingtalk_status = ?,
      dingtalk_response = ?
    WHERE id = ?
    `
  )
    .bind(
      wxpusherStatus,
      JSON.stringify(wxpusherResult),
      dingtalkStatus,
      JSON.stringify(dingtalkResult),
      id
    )
    .run();

  const noChannelConfigured =
    wxpusherResult.skipped === true &&
    dingtalkResult.skipped === true;

  const pushOk =
    wxpusherResult.ok ||
    dingtalkResult.ok ||
    noChannelConfigured;

  return jsonResponse(
    {
      ok: pushOk,
      message: pushOk ? "消息已处理" : "消息已保存，但推送失败",
      data: {
        id,
        from: "me",
        text: message,
        time: formatDisplayTime(nowIso),
        createdAt: new Date(nowIso).getTime(),
        channel: "all",
        wxpusherStatus,
        dingtalkStatus
      },
      push: {
        wxpusher: wxpusherResult,
        dingtalk: dingtalkResult
      }
    },
    pushOk ? 200 : 502
  );
}

async function handleParentReply(request, env) {
  assertDb(env);

  const body = await readJson(request);
  const message = String(body.message || "").trim();

  if (!message) {
    return jsonResponse(
      {
        ok: false,
        message: "回复内容不能为空"
      },
      400
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse(
      {
        ok: false,
        message: `回复太长了，最多 ${MAX_MESSAGE_LENGTH} 个字符`
      },
      400
    );
  }

  const id = createId();
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO messages (
      id,
      from_type,
      content,
      channel,
      created_at,
      wxpusher_status,
      wxpusher_response,
      dingtalk_status,
      dingtalk_response
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      "parent",
      message,
      "reply",
      nowIso,
      "",
      "",
      "",
      ""
    )
    .run();

  return jsonResponse({
    ok: true,
    message: "父母回复已保存",
    data: {
      id,
      from: "parent",
      text: message,
      time: formatDisplayTime(nowIso),
      createdAt: new Date(nowIso).getTime()
    }
  });
}

async function sendWxPusher(env, content, rawMessage) {
  const appToken = String(env.WXPUSHER_APP_TOKEN || "").trim();
  const uidText = String(env.WXPUSHER_UIDS || "").trim();

  if (!appToken || !uidText) {
    return {
      ok: false,
      skipped: true,
      message: "WxPusher 未配置，已跳过"
    };
  }

  const uids = uidText
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

  if (uids.length === 0) {
    return {
      ok: false,
      skipped: true,
      message: "WxPusher UID 为空，已跳过"
    };
  }

  const payload = {
    appToken,
    content,
    summary: makeSummary(rawMessage),
    contentType: 1,
    uids,
    verifyPayType: 0
  };

  const res = await fetch("https://wxpusher.zjiecode.com/api/send/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await safeReadJson(res);
  const ok = res.ok && data && data.code === 1000;

  return {
    ok,
    skipped: false,
    status: res.status,
    message: ok ? "WxPusher 推送成功" : "WxPusher 推送失败",
    response: data
  };
}

async function sendDingTalk(env, content) {
  const webhook = String(env.DINGTALK_WEBHOOK || "").trim();
  const secret = String(env.DINGTALK_SECRET || "").trim();

  if (!webhook) {
    return {
      ok: false,
      skipped: true,
      message: "钉钉 Webhook 未配置，已跳过"
    };
  }

  const url = secret
    ? await buildDingTalkSignedUrl(webhook, secret)
    : webhook;

  const payload = {
    msgtype: "text",
    text: {
      content
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  const data = await safeReadJson(res);
  const ok = res.ok && data && data.errcode === 0;

  return {
    ok,
    skipped: false,
    status: res.status,
    message: ok ? "钉钉推送成功" : "钉钉推送失败",
    response: data
  };
}

async function buildDingTalkSignedUrl(webhook, secret) {
  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}\n${secret}`;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(stringToSign)
  );

  const sign = arrayBufferToBase64(signature);

  const url = new URL(webhook);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("sign", sign);

  return url.toString();
}


function buildPushText(message, env) {
  const base = env.APP_BASE_URL || "";
  const replyUrl = `${base}/reply.html`;

  return `【学校快捷联系】
${message}

时间：${getNowTime()}

👉 点击回复：
${replyUrl}`;
}


function normalizeSettledResult(result) {
  if (result.status === "fulfilled") {
    return result.value;
  }

  return {
    ok: false,
    skipped: false,
    message:
      result.reason && result.reason.message
        ? result.reason.message
        : "推送异常"
  };
}

function assertDb(env) {
  if (!env.DB) {
    throw new Error("D1 数据库没有绑定，请在 Pages 项目里绑定 DB");
  }
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function safeReadJson(res) {
  try {
    return await res.json();
  } catch {
    try {
      const text = await res.text();
      return {
        raw: text
      };
    } catch {
      return null;
    }
  }
}

async function handleClearMessages(env) {
  assertDb(env);

  await env.DB.prepare(`
    DELETE FROM messages
  `).run();

  return jsonResponse({
    ok: true,
    message: "已清空所有消息"
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getPath(params) {
  const raw = params && params.path;

  if (!raw) {
    return "";
  }

  if (Array.isArray(raw)) {
    return raw.join("/");
  }

  return String(raw).replace(/^\/+|\/+$/g, "");
}

function createId() {
  if (crypto.randomUUID) {
    return `msg_${Date.now()}_${crypto.randomUUID()}`;
  }

  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getNowTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

function formatDisplayTime(isoString) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(isoString));
}

function makeSummary(content) {
  const text = String(content || "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= 18) {
    return text || "新消息";
  }

  return text.slice(0, 18);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}
