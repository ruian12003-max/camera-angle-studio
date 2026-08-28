const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');

const ROOT = __dirname;
loadDotEnv();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 43127);
const OFFICIAL_API_URL = 'https://api.openai.com/v1/images/edits';
const allowedSizes = new Set([
  '1024x1024', '1360x768', '768x1360', '1152x864', '1248x832',
  '2048x2048', '2048x1152', '1152x2048', '2048x1536', '2048x1360',
  '2880x2880', '3840x2160', '2160x3840', '3328x2480', '3520x2352'
]);

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || origin === 'null' || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key, X-OpenAI-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(req, res, status, payload) {
  cors(req, res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJson(req, maxBytes = 75 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > maxBytes) { reject(new Error('上传图片过大')); req.destroy(); return; } body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('请求数据格式错误')); } });
    req.on('error', reject);
  });
}

function extractImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('参考图格式无效');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('参考图必须小于 50MB');
  return { type: match[1], bytes };
}

function resolveApiUrl(input) {
  const raw = String(input || process.env.OPENAI_API_URL || OFFICIAL_API_URL).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('API URL 格式无效'); }
  if (url.username || url.password) throw new Error('API URL 不能包含用户名或密码');
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('公网 API URL 必须使用 HTTPS');
  url.search = ''; url.hash = '';
  const cleanPath = url.pathname.replace(/\/+$/, '');
  if (!cleanPath || cleanPath === '/') url.pathname = '/v1/images/edits';
  else if (cleanPath.endsWith('/v1')) url.pathname = `${cleanPath}/images/edits`;
  else url.pathname = cleanPath;
  return url.toString();
}

function resolveModelsUrl(input) {
  const url = new URL(resolveApiUrl(input));
  const cleanPath = url.pathname.replace(/\/+$/, '');
  if (cleanPath.endsWith('/images/edits')) {
    url.pathname = `${cleanPath.slice(0, -'/images/edits'.length)}/models`;
  } else {
    const v1Index = cleanPath.toLowerCase().lastIndexOf('/v1');
    url.pathname = v1Index >= 0 ? `${cleanPath.slice(0, v1Index + 3)}/models` : '/v1/models';
  }
  return url;
}

function networkErrorMessage(error) {
  const code = error?.cause?.code || error?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS 解析失败：请检查 API URL 的域名是否填写正确或仍然有效';
  if (code === 'ECONNREFUSED') return '端口连接被拒绝：服务器未开放该端口或服务未启动';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：域名可解析，但服务器端口没有及时响应';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'HTTPS 证书校验失败：请联系接口服务商修复证书';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '接口响应超时';
  return error?.message === 'fetch failed' ? '网络请求失败：请先使用“检测”查看 DNS、端口和接口状态' : (error?.message || '网络请求失败');
}

function probePort(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(port);
    };
    const options = { host: url.hostname, port };
    const socket = url.protocol === 'https:'
      ? tls.connect({ ...options, servername: url.hostname, rejectUnauthorized: true })
      : net.createConnection(options);
    const timer = setTimeout(() => {
      const error = new Error('端口连接超时'); error.code = 'ETIMEDOUT'; done(error);
    }, timeoutMs);
    socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => done());
    socket.once('error', done);
  });
}

async function checkProvider(req, res) {
  const started = Date.now();
  try {
    const body = await readJson(req, 256 * 1024);
    const browserKey = String(req.headers['x-provider-key'] || req.headers['x-openai-key'] || '').trim();
    const apiKey = browserKey || process.env.OPENAI_API_KEY || '';
    const modelsUrl = resolveModelsUrl(body.apiUrl);

    try { await dns.lookup(modelsUrl.hostname); }
    catch (error) { return json(req, res, 200, { ok: false, stage: 'dns', error: networkErrorMessage(error), endpoint: modelsUrl.toString() }); }

    // 端口探测只作为辅助信息，不能在 TLS 探测偶发误判时直接结束。
    // 只要 /v1/models 返回了 HTTP 响应，就已经证明域名、端口和接口是可达的。
    let portError = null;
    try { await probePort(modelsUrl); }
    catch (error) { portError = error; }

    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let upstream;
    try {
      upstream = await fetch(modelsUrl, {
        method: 'GET', headers,
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      return json(req, res, 200, {
        ok: false,
        stage: 'port',
        error: networkErrorMessage(portError || error),
        endpoint: modelsUrl.toString()
      });
    }
    const latencyMs = Date.now() - started;
    if (upstream.ok) return json(req, res, 200, { ok: true, stage: 'complete', message: `接口与 Key 检测通过 · ${latencyMs}ms`, status: upstream.status, endpoint: modelsUrl.toString(), latencyMs });
    if (upstream.status === 401 || upstream.status === 403) {
      const error = apiKey
        ? `域名、443 端口和接口均可达，但 API Key 无效或无权限（HTTP ${upstream.status}）`
        : `域名、443 端口和接口均可达，但尚未填写 API Key（HTTP ${upstream.status}）`;
      return json(req, res, 200, { ok: false, stage: 'auth', error, status: upstream.status, endpoint: modelsUrl.toString(), latencyMs });
    }
    if (upstream.status === 404 || upstream.status === 405) return json(req, res, 200, { ok: false, stage: 'endpoint', error: `域名与端口可达，但服务商未提供兼容的 /v1/models 检测接口（HTTP ${upstream.status}）`, status: upstream.status, endpoint: modelsUrl.toString(), latencyMs });
    return json(req, res, 200, { ok: false, stage: 'http', error: `域名与端口可达，但检测接口返回 HTTP ${upstream.status}`, status: upstream.status, endpoint: modelsUrl.toString(), latencyMs });
  } catch (error) {
    return json(req, res, 200, { ok: false, stage: 'request', error: networkErrorMessage(error) });
  }
}

async function downloadReturnedImage(imageUrl) {
  let url;
  try { url = new URL(imageUrl); } catch { throw new Error('第三方接口返回了无效图片地址'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('第三方图片地址协议不受支持');
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`无法下载第三方生成图片（${response.status}）`);
  const type = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  if (!type.startsWith('image/')) throw new Error('第三方返回地址不是图片');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('第三方生成图片为空或超过 50MB');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function generate(req, res) {
  try {
    const body = await readJson(req);
    const browserKey = String(req.headers['x-provider-key'] || req.headers['x-openai-key'] || '').trim();
    const apiKey = browserKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return json(req, res, 401, { error: '未配置 API Key' });
    const apiUrl = resolveApiUrl(body.apiUrl);
    const prompt = String(body.prompt || '').trim();
    if (!prompt || prompt.length > 32000) return json(req, res, 400, { error: '提示词为空或过长' });
    if (!allowedSizes.has(body.size)) return json(req, res, 400, { error: '不支持的输出尺寸' });
    if (!['low','medium','high'].includes(body.quality)) return json(req, res, 400, { error: '不支持的画质参数' });
    const source = extractImage(body.image);

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('image[]', new Blob([source.bytes], { type: source.type }), source.type === 'image/png' ? 'reference.png' : 'reference.jpg');
    form.append('prompt', prompt);
    form.append('size', body.size);
    form.append('quality', body.quality);
    form.append('output_format', 'jpeg');
    form.append('output_compression', '92');

    const upstream = await fetch(apiUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(180000)
    });
    const requestId = upstream.headers.get('x-request-id');
    const raw = await upstream.text();
    let data; try { data = JSON.parse(raw); } catch { data = {}; }
    if (!upstream.ok) {
      const message = data?.error?.message || `OpenAI 请求失败（${upstream.status}）`;
      return json(req, res, upstream.status, { error: message, code: data?.error?.code, requestId });
    }
    const encoded = data?.data?.[0]?.b64_json;
    const returnedUrl = data?.data?.[0]?.url;
    if (!encoded && !returnedUrl) return json(req, res, 502, { error: '第三方接口未返回 b64_json 或图片 URL', requestId });
    const image = encoded ? `data:image/jpeg;base64,${encoded}` : await downloadReturnedImage(returnedUrl);
    return json(req, res, 200, { image, requestId, usage: data.usage || null, providerHost: new URL(apiUrl).host });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return json(req, res, timedOut ? 504 : 500, { error: timedOut ? '生成超时，请降低分辨率后重试' : networkErrorMessage(error) });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(req, res, 200, { ok: true, configured: Boolean(process.env.OPENAI_API_KEY), model: 'gpt-image-2', defaultApiUrl: process.env.OPENAI_API_URL || 'https://api.openai.com/v1' });
  if (req.method === 'POST' && url.pathname === '/api/check-provider') return checkProvider(req, res);
  if (req.method === 'POST' && url.pathname === '/api/generate') return generate(req, res);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  json(req, res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`镜位台已启动：http://${HOST}:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? '已读取服务端 OPENAI_API_KEY。' : '未配置服务端 Key，可在网页中临时输入。');
});
