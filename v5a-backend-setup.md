# v5a: 后端从零搭建 (Next.js + Vercel + 抠图 API)

> 本文档是 Cursor 的 source of truth。严格按此执行,不要自由发挥。
> 范围: 从零新建一个 Next.js 项目,写 `/api/segment` 抠图接口,部署到 Vercel,绑定 `api.feihan.cc`。
> 执行完成后,前往 `v5b-miniapp-integration.md` 做小程序端接入。

---

## 0. 背景

- 田园徽州小程序此前无后端,全部功能在小程序端 Canvas 完成
- 现在要引入第一个后端,只用于调用阿里云 SegmentCommodity (密钥不能泄漏到小程序包)
- 后端定位: 轻量 API 层,只做"密钥代理 + 缓存",不涉及业务数据库
- 部署目标: Vercel Hobby (免费版),10s 函数超时,失败时前端自动重试一次

---

## 1. 项目初始化

### 1.1 新建独立仓库

在任意工作目录下执行:

```bash
cd ~/projects # 或你的工作根目录
pnpm create next-app@latest tianyuan-huizhou-api \
  --ts \
  --app \
  --no-tailwind \
  --no-src-dir \
  --no-eslint \
  --import-alias "@/*"
cd tianyuan-huizhou-api
```

选项说明:
- `--app`: App Router (Next.js 14+ 标准)
- `--no-tailwind`: 后端项目不需要 UI,不装 Tailwind
- `--no-src-dir`: 根目录放 `app/`,层级浅一点
- `--no-eslint`: 省掉初始配置复杂度,hackathon 不纠结

### 1.2 清理默认页面

这个项目不需要前端页面,清理掉默认内容:

```bash
rm -rf app/page.tsx app/globals.css app/favicon.ico public/*
```

编辑 `app/layout.tsx`,简化为:

```tsx
export const metadata = {
  title: 'Tianyuan Huizhou API',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

新建 `app/page.tsx` 做一个简单的健康检查页:

```tsx
export default function Home() {
  return <pre>{JSON.stringify({ service: 'tianyuan-huizhou-api', status: 'ok' })}</pre>;
}
```

### 1.3 初始化 git

```bash
git init
git add .
git commit -m "init: next.js skeleton"
```

先不推 remote,等代码写完一起推。

---

## 2. 依赖安装

```bash
pnpm add @alicloud/openapi-client @alicloud/tea-util cos-nodejs-sdk-v5
```

这些包的作用:
- `@alicloud/openapi-client`: 走 **POP RPC** 调用分割抠图 `SegmentCommodity` (商品分割在 **imageseg** 产品, npm 上的 `@alicloud/viapi20230117` 不含该接口,故不用 viapi SDK)
- `@alicloud/tea-util`: `RuntimeOptions` 等运行时类型,`callApi` 需要
- `cos-nodejs-sdk-v5`: 腾讯 COS Node SDK

---

## 3. 环境变量

### 3.1 本地开发

项目根目录新建 `.env.local`:

```bash
# 阿里云 SegmentCommodity (imageseg 华东2上海); 变量名仍用 ALIYUN_VIAPI_ENDPOINT
ALIYUN_ACCESS_KEY_ID=<你的 RAM 子账号 AK ID>
ALIYUN_ACCESS_KEY_SECRET=<你的 RAM 子账号 AK Secret>
ALIYUN_VIAPI_ENDPOINT=imageseg.cn-shanghai.aliyuncs.com

# 腾讯 COS (复用已配置的 bucket)
TENCENT_SECRET_ID=<你的腾讯云 SecretId>
TENCENT_SECRET_KEY=<你的腾讯云 SecretKey>
TENCENT_COS_BUCKET=tianyuan-huizhou-1258537429
TENCENT_COS_REGION=ap-shanghai

# 自定义域名 (用于拼接返回给前端的 URL)
PUBLIC_CDN_DOMAIN=https://public.feihan.cc
```

### 3.2 确认 .gitignore

`.gitignore` 应该已经有 `.env*.local` 这一行 (Next.js 默认生成的)。确认一下,避免密钥提交到 git:

```bash
cat .gitignore | grep env
```

如果没有,追加:

```
.env*.local
```

---

## 4. 后端代码

### 4.1 COS 工具函数

新建 `lib/cos.ts`:

```typescript
import COS from 'cos-nodejs-sdk-v5';

const cos = new COS({
  SecretId: process.env.TENCENT_SECRET_ID!,
  SecretKey: process.env.TENCENT_SECRET_KEY!,
});

const BUCKET = process.env.TENCENT_COS_BUCKET!;
const REGION = process.env.TENCENT_COS_REGION!;
const CDN = process.env.PUBLIC_CDN_DOMAIN!;

/**
 * 检查 COS 上对象是否存在
 */
export async function cosObjectExists(key: string): Promise<boolean> {
  try {
    await cos.headObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
    });
    return true;
  } catch (err: any) {
    if (err?.statusCode === 404) return false;
    throw err;
  }
}

/**
 * 上传 Buffer 到 COS, 返回 public URL
 */
export async function cosPutBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await cos.putObject({
    Bucket: BUCKET,
    Region: REGION,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  return `${CDN}/${key}`;
}

/**
 * 拼接 public URL (不上传, 只拼)
 */
export function cosPublicUrl(key: string): string {
  return `${CDN}/${key}`;
}
```

### 4.2 SegmentCommodity 工具函数

新建 `lib/segment.ts`,使用 `@alicloud/openapi-client` 的 **POP RPC** 调用 `SegmentCommodity` (`version: 2019-12-30`, `query.ImageURL`)。**不要**再引用 `@alicloud/viapi20230117`。

```typescript
import Client from '@alicloud/openapi-client';
import * as $OpenApi from '@alicloud/openapi-client';
import * as $Util from '@alicloud/tea-util';

const client = new Client(
  new $OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID!,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET!,
    endpoint: process.env.ALIYUN_VIAPI_ENDPOINT!,
    regionId: 'cn-shanghai',
  }),
);

export class SegmentError extends Error {
  code: 'SEGMENT_NO_SUBJECT' | 'SEGMENT_API_FAILED';
  constructor(code: SegmentError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 调用阿里云 SegmentCommodity, 返回阿里云临时 PNG URL
 * 注意: 阿里云返回的 URL 有效期有限, 调用方需要立刻下载并转存
 */
export async function segmentCommodity(imageUrl: string): Promise<string> {
  const runtime = new $Util.RuntimeOptions({});
  const req = new $OpenApi.OpenApiRequest({
    query: {
      ImageURL: imageUrl,
    },
  });
  const params = new $OpenApi.Params({
    action: 'SegmentCommodity',
    version: '2019-12-30',
    protocol: 'HTTPS',
    pathname: '/',
    method: 'POST',
    authType: 'AK',
    style: 'RPC',
    reqBodyType: 'formData',
    bodyType: 'json',
  });

  try {
    const resp = await client.callApi(params, req, runtime);
    const body = resp?.body ?? resp;
    const data = body?.Data ?? body?.data;
    const resultUrl = data?.ImageURL ?? data?.imageURL;
    if (!resultUrl) {
      throw new SegmentError('SEGMENT_NO_SUBJECT', '未识别到商品主体');
    }
    return resultUrl;
  } catch (err: any) {
    if (err instanceof SegmentError) throw err;
    const code = err?.code || err?.data?.Code || '';
    if (code === 'InvalidImage.NoObject' || code === 'NoObjectDetected') {
      throw new SegmentError('SEGMENT_NO_SUBJECT', '未识别到商品主体');
    }
    console.error('[segment] SegmentCommodity POP call failed:', err);
    throw new SegmentError('SEGMENT_API_FAILED', err?.message || 'SegmentCommodity 调用失败');
  }
}
```

**Endpoint**: `ALIYUN_VIAPI_ENDPOINT` **取值**须为商品分割专属域名 `imageseg.cn-shanghai.aliyuncs.com`(与通用 viapi 网关 `viapi.cn-shanghai.aliyuncs.com` 不同)。

### 4.3 API Route

新建 `app/api/segment/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  cosObjectExists,
  cosPutBuffer,
  cosPublicUrl,
} from '@/lib/cos';
import { segmentCommodity, SegmentError } from '@/lib/segment';

export const runtime = 'nodejs';
export const maxDuration = 60; // 声明为 60 秒 (免费版实际上限 10 秒, 但这行不会报错)

interface SegmentSuccessResp {
  ok: true;
  imageUrl: string;
  cached: boolean;
}

interface SegmentErrorResp {
  ok: false;
  code: 'SEGMENT_NO_SUBJECT' | 'SEGMENT_API_FAILED' | 'UPLOAD_FAILED' | 'BAD_INPUT';
  message: string;
}

/**
 * CORS 预检响应 (小程序 wx.request 不需要 CORS, 但如果未来有 H5 接入会用到)
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const base64 = body?.imageBase64 as string | undefined;

    if (!base64 || typeof base64 !== 'string') {
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'BAD_INPUT', message: 'imageBase64 必填' },
        { status: 400 },
      );
    }

    // 剥离 data URL 前缀
    const rawBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(rawBase64, 'base64');

    if (buffer.length === 0) {
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'BAD_INPUT', message: '图片数据为空' },
        { status: 400 },
      );
    }

    // 图片大小限制 10MB (留出 buffer, 小程序端也会限制)
    if (buffer.length > 10 * 1024 * 1024) {
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'BAD_INPUT', message: '图片超过 10MB' },
        { status: 400 },
      );
    }

    // 1. 计算 MD5
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const cacheKey = `segment_cache/${md5}.png`;

    // 2. 查缓存
    const exists = await cosObjectExists(cacheKey);
    if (exists) {
      return NextResponse.json<SegmentSuccessResp>({
        ok: true,
        imageUrl: cosPublicUrl(cacheKey),
        cached: true,
      });
    }

    // 3. 原图上传到 uploads_temp/
    const uploadKey = `uploads_temp/${md5}.jpg`;
    let uploadUrl: string;
    try {
      uploadUrl = await cosPutBuffer(uploadKey, buffer, 'image/jpeg');
    } catch (err) {
      console.error('[segment] upload temp failed:', err);
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'UPLOAD_FAILED', message: '原图上传失败' },
        { status: 500 },
      );
    }

    // 4. 调用阿里云 SegmentCommodity
    let aliResultUrl: string;
    try {
      aliResultUrl = await segmentCommodity(uploadUrl);
    } catch (err) {
      if (err instanceof SegmentError) {
        return NextResponse.json<SegmentErrorResp>(
          { ok: false, code: err.code, message: err.message },
          { status: 422 },
        );
      }
      throw err;
    }

    // 5. 下载阿里云返回的 PNG
    let pngBuffer: Buffer;
    try {
      const resp = await fetch(aliResultUrl);
      if (!resp.ok) {
        throw new Error(`fetch ali result http ${resp.status}`);
      }
      pngBuffer = Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      console.error('[segment] download ali result failed:', err);
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'SEGMENT_API_FAILED', message: '抠图结果下载失败' },
        { status: 500 },
      );
    }

    // 6. 上传到 segment_cache/
    let cachedUrl: string;
    try {
      cachedUrl = await cosPutBuffer(cacheKey, pngBuffer, 'image/png');
    } catch (err) {
      console.error('[segment] upload cache failed:', err);
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'UPLOAD_FAILED', message: '抠图结果存储失败' },
        { status: 500 },
      );
    }

    return NextResponse.json<SegmentSuccessResp>({
      ok: true,
      imageUrl: cachedUrl,
      cached: false,
    });
  } catch (err: any) {
    console.error('[segment] unexpected:', err);
    return NextResponse.json<SegmentErrorResp>(
      { ok: false, code: 'SEGMENT_API_FAILED', message: err?.message || '未知错误' },
      { status: 500 },
    );
  }
}
```

### 4.4 健康检查路由 (可选, 但推荐)

新建 `app/api/health/route.ts`:

```typescript
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasAliyunAK: !!process.env.ALIYUN_ACCESS_KEY_ID,
      hasTencentSecret: !!process.env.TENCENT_SECRET_ID,
      cdnDomain: process.env.PUBLIC_CDN_DOMAIN,
    },
  });
}
```

部署后访问 `https://api.feihan.cc/api/health` 快速确认环境变量都注入成功了 (不会泄漏密钥, 只暴露 boolean)。

---

## 5. 本地测试

### 5.1 启动

```bash
pnpm dev
```

默认跑在 `http://localhost:3000`。

### 5.2 健康检查

```bash
curl http://localhost:3000/api/health | jq
```

预期返回 `hasAliyunAK: true`, `hasTencentSecret: true`。如果是 false, 检查 `.env.local` 变量名拼写。

### 5.3 抠图测试

准备一张电商风格的产品图 (比如一盒茶叶、一包香榧),命名 `test.jpg` 放在项目根目录或 `public/test.jpg`。执行:

```bash
# macOS / Linux (示例: 使用 public/test.jpg)
BASE64=$(base64 -i public/test.jpg | tr -d '\n')
curl -X POST http://localhost:3000/api/segment \
  -H "Content-Type: application/json" \
  -d "{\"imageBase64\":\"$BASE64\"}" | jq
```

预期输出:

```json
{
  "ok": true,
  "imageUrl": "https://public.feihan.cc/segment_cache/xxxxx.png",
  "cached": false
}
```

浏览器打开这个 URL, 应该看到透明底 (棋盘格背景) 的抠图结果。

再次执行同一条命令, `cached` 应该变成 `true`, 响应时间 < 500ms。

---

## 6. 部署到 Vercel

### 6.1 推送到 GitHub

```bash
# 在 github.com 新建 private 仓库 tianyuan-huizhou-api (不要勾选初始化)
git remote add origin git@github.com:<你的用户名>/tianyuan-huizhou-api.git
git branch -M main
git push -u origin main
```

### 6.2 Vercel 导入项目

访问 https://vercel.com/new, 选 `Import Git Repository`, 授权 GitHub 后选 `tianyuan-huizhou-api`。

**Configure Project 页面配置**:

- Framework Preset: `Next.js` (自动识别)
- Root Directory: 保持默认 (仓库根)
- Build Command: 保持默认
- Output Directory: 保持默认
- Install Command: 改为 `pnpm install`

**Environment Variables 展开**, 把 `.env.local` 里的 6 个变量全部粘贴进去:

| Name | Value |
|---|---|
| `ALIYUN_ACCESS_KEY_ID` | 你的 AK ID |
| `ALIYUN_ACCESS_KEY_SECRET` | 你的 AK Secret |
| `ALIYUN_VIAPI_ENDPOINT` | `imageseg.cn-shanghai.aliyuncs.com` |
| `TENCENT_SECRET_ID` | 你的腾讯云 SecretId |
| `TENCENT_SECRET_KEY` | 你的腾讯云 SecretKey |
| `TENCENT_COS_BUCKET` | `tianyuan-huizhou-1258537429` |
| `TENCENT_COS_REGION` | `ap-shanghai` |
| `PUBLIC_CDN_DOMAIN` | `https://public.feihan.cc` |

点 `Deploy`, 等 2-3 分钟。

### 6.3 首次部署验证

部署成功后 Vercel 给一个默认域名, 比如 `tianyuan-huizhou-api.vercel.app`。访问:

```
https://tianyuan-huizhou-api.vercel.app/api/health
```

能返回 JSON 说明部署成功。

**如果在国内访问这个默认域名卡顿或失败是正常的**, vercel.app 域名国内访问不稳定。继续下一步绑定自定义域名就好。

### 6.4 绑定 api.feihan.cc

在 Vercel 项目控制台:
1. Settings → Domains
2. 输入 `api.feihan.cc`, 点 Add
3. Vercel 会给出 DNS 配置要求, 通常是:
   - Type: `CNAME`
   - Name: `api`
   - Value: `cname.vercel-dns.com`

去 DNSPod (或你当前 feihan.cc 的 DNS 服务商) 添加这条 CNAME 记录。

DNS 生效后 (通常几分钟到半小时), Vercel 自动签发 SSL 证书。

访问 `https://api.feihan.cc/api/health` 应该能通。

### 6.5 生产环境冒烟测试

用 curl 测一把生产环境抠图接口:

```bash
BASE64=$(base64 -i test.jpg | tr -d '\n')
curl -X POST https://api.feihan.cc/api/segment \
  -H "Content-Type: application/json" \
  -d "{\"imageBase64\":\"$BASE64\"}" | jq
```

返回和本地一致则通过。

---

## 7. 自测 checklist

- [ ] 本地 `pnpm dev` 启动无错
- [ ] `curl http://localhost:3000/api/health` 返回 hasAliyunAK: true, hasTencentSecret: true
- [ ] 本地抠图测试: 首次调用返回 `cached: false`, 二次调用返回 `cached: true`
- [ ] 浏览器打开返回的 imageUrl 看到透明底抠图结果
- [ ] 用一张没有商品的图 (纯风景) 测试, 返回 `{ ok: false, code: "SEGMENT_NO_SUBJECT" }`
- [ ] GitHub 仓库已推送 (注意 `.env.local` 未被提交)
- [ ] Vercel 部署成功, `https://xxx.vercel.app/api/health` 可访问
- [ ] `api.feihan.cc` DNS 解析生效, SSL 证书有效
- [ ] `https://api.feihan.cc/api/segment` 生产环境冒烟测试通过

---

## 8. 已知风险与应对

### 风险 1: Vercel 免费版 10s 超时
- 首次抠图 (未命中缓存) 链路: 上传 2s + viapi 3-5s + 下载 1s + 上传 2s ≈ 8-10s
- 概率性踩线, 表现为前端收到 504
- **应对**: v5b 的小程序端会写"失败自动重试一次", 第二次调用时原图已在 `uploads_temp/` (严格说这次调用不会复用, 会重新上传, 但是 viapi 接收 URL 一致时有服务端幂等性, 通常更快), 大概率成功
- 如果演示现场发现超时率高 (>20%), 立刻在 Vercel 控制台升级 Pro plan, 10s 会提升到 60s, 按月计费可以随时退订

### 风险 2: vercel-dns.com 在国内解析慢
- 部分运营商对 `cname.vercel-dns.com` 解析时间长 (1-5s)
- **应对**: 如果发现评委手机访问 `api.feihan.cc` 首次加载慢, 可以在 DNSPod 做智能解析, 境外走 CNAME, 境内用 A 记录直接指 Vercel IP (不推荐, 不稳定)。hackathon 不折腾, 演示前一小时用多个手机真机测一遍能通就行

### 风险 3: 阿里云 viapi 免费额度 500 次/月
- 缓存命中不消耗额度, 但首次调用会
- hackathon 5 天估计最多消耗 100-200 次, 不会超
- **应对**: 后台看板 https://viapi.console.aliyun.com/overview 可以看已用量

---

## 9. 不要做的事

- 不要给 API Route 加鉴权 (hackathon 阶段全开, 上线真实用户前再补)
- 不要写数据库 (这个后端现阶段无持久化需求, 缓存靠 COS 对象存在性判断)
- 不要实现删除 / 列表接口 (只做抠图一件事)
- 不要把 AK / SecretKey 放到前端 env 变量 (Next.js 里以 `NEXT_PUBLIC_` 开头的变量会被打包到客户端)
- 不要在本仓库存任何业务图片或模板 (图片资产归 COS 管)

---

## 10. 完成后

本 md 所有 checklist 打勾后, 切换到田园徽州小程序仓库, 执行 `v5b-miniapp-integration.md`。
