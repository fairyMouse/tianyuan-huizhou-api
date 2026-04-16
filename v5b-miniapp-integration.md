# v5b: 小程序端接入抠图 (Taro → api.feihan.cc)

> 本文档是 Cursor 的 source of truth。严格按此执行,不要自由发挥。
> 范围: 田园徽州 Taro 小程序项目里,调用 `https://api.feihan.cc/api/segment`, 拿到抠图后的 PNG URL,传给现有 composer 做合成。
> 前置: `v5a-backend-setup.md` 必须已完成, `https://api.feihan.cc/api/segment` 已在生产可用。
> 执行完成后: 真机预览生产版小程序, 从上传 → 抠图 → 合成完整链路打通。

---

## 0. 背景 & 范围确认

这次改造**只做两件事**:

1. 新增 `services/segment.ts`, 封装抠图 API 调用
2. 在生成页 (Generating 页面) 的流程里插入抠图步骤, 把抠图 URL 传给现有 composer

**不改的东西**:

- composer.ts 的 Canvas 合成逻辑 (v6 会改)
- 模板 registry (`constants/templates.ts`)
- 上传页、品类选择页、结果页的 UI
- 任何 Hui 前缀的通用组件

---

## 1. 小程序合法域名配置 (必须先做)

登录微信公众平台 https://mp.weixin.qq.com → 对应小程序 → 开发 → 开发管理 → 开发设置 → 服务器域名。

**request 合法域名**: 追加 `https://api.feihan.cc`
**downloadFile 合法域名**: 追加 `https://api.feihan.cc` 和 `https://public.feihan.cc` (如果 public 域名还没加过)

微信后台一个月限 5 次修改, 一次性把两个域名都加齐, 不要分多次改。

追加后即时生效, 不需要审核。

---

## 2. 新增 segment service

### 2.1 创建文件

新建 `src/services/segment.ts`。如果项目没有 `src/services/` 目录, 先创建。

```typescript
import Taro from '@tarojs/taro';

// API 基地址通过环境变量配置, 方便未来切换到 staging
// 如果没配置 env, fallback 到生产地址
const API_BASE = process.env.TARO_APP_API_BASE || 'https://api.feihan.cc';

/** 抠图成功 */
export interface SegmentSuccess {
  ok: true;
  /** 抠图后的 PNG URL (public.feihan.cc 域下, 永久有效) */
  imageUrl: string;
  /** 是否命中缓存, 用于埋点 (可选) */
  cached: boolean;
}

/** 抠图失败 */
export interface SegmentFail {
  ok: false;
  code: 'SEGMENT_NO_SUBJECT' | 'SEGMENT_API_FAILED' | 'UPLOAD_FAILED' | 'BAD_INPUT' | 'TIMEOUT' | 'NETWORK';
  message: string;
}

export type SegmentResult = SegmentSuccess | SegmentFail;

/**
 * 读本地图片文件为 base64 字符串
 */
async function readFileAsBase64(localFilePath: string): Promise<string> {
  const fs = Taro.getFileSystemManager();
  return new Promise((resolve, reject) => {
    fs.readFile({
      filePath: localFilePath,
      encoding: 'base64',
      success: (res) => resolve(res.data as string),
      fail: (err) => reject(err),
    });
  });
}

/**
 * 调用后端抠图接口
 * 内置一次自动重试 (应对 Vercel 首次冷启或 10s 超时)
 */
export async function segmentImage(localFilePath: string): Promise<SegmentResult> {
  let base64: string;
  try {
    base64 = await readFileAsBase64(localFilePath);
  } catch (err) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      message: '读取本地图片失败',
    };
  }

  // 图片体积保护 (base64 膨胀 33%, 小程序 wx.request body 上限 10MB)
  // 原始字节数估算: base64 长度 * 3 / 4
  const approximateBytes = Math.floor((base64.length * 3) / 4);
  if (approximateBytes > 7 * 1024 * 1024) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      message: '图片太大, 请选小于 7MB 的图片',
    };
  }

  return callApiWithRetry(base64, 2);
}

/**
 * 调用 API, 支持重试。
 * attempts: 总尝试次数 (含首次), 默认 2 表示首次失败后再重试 1 次
 */
async function callApiWithRetry(base64: string, attempts: number): Promise<SegmentResult> {
  let lastFail: SegmentFail | null = null;

  for (let i = 0; i < attempts; i++) {
    const result = await callApiOnce(base64);
    if (result.ok) {
      return result;
    }
    lastFail = result;

    // 只对网络类错误重试, 业务错误不重试
    const shouldRetry = result.code === 'TIMEOUT' || result.code === 'NETWORK' || result.code === 'SEGMENT_API_FAILED';
    if (!shouldRetry) {
      return result;
    }

    // 重试前短暂等待 (指数退避)
    if (i < attempts - 1) {
      await sleep(800 * (i + 1));
    }
  }

  return lastFail!;
}

async function callApiOnce(base64: string): Promise<SegmentResult> {
  try {
    const resp = await Taro.request({
      url: `${API_BASE}/api/segment`,
      method: 'POST',
      data: { imageBase64: base64 },
      header: { 'Content-Type': 'application/json' },
      timeout: 15000, // Vercel 免费版 10s 超时, 客户端给 15s 冗余
    });

    // Taro 把 HTTP 4xx/5xx 也作为成功返回, 要自己判状态码
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return resp.data as SegmentSuccess;
    }

    // 4xx 是业务错误, 服务端返回了结构化 body
    if (resp.statusCode >= 400 && resp.statusCode < 500) {
      const fail = resp.data as SegmentFail;
      if (fail?.code && fail?.message) return fail;
      return {
        ok: false,
        code: 'SEGMENT_API_FAILED',
        message: `HTTP ${resp.statusCode}`,
      };
    }

    // 5xx 或其他, 按 API 失败处理 (会触发重试)
    return {
      ok: false,
      code: 'SEGMENT_API_FAILED',
      message: `HTTP ${resp.statusCode}`,
    };
  } catch (err: any) {
    const errMsg = String(err?.errMsg || err?.message || '');
    if (errMsg.includes('timeout')) {
      return { ok: false, code: 'TIMEOUT', message: '请求超时' };
    }
    return {
      ok: false,
      code: 'NETWORK',
      message: errMsg || '网络错误',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

### 2.2 环境变量 (可选)

Taro 支持通过 `process.env.TARO_APP_XXX` 注入环境变量。如果想区分开发和生产环境:

编辑 `config/dev.ts`:

```typescript
export default {
  env: {
    NODE_ENV: '"development"',
    TARO_APP_API_BASE: '"https://api.feihan.cc"', // 开发期间也直接打生产后端, 省事
  },
};
```

编辑 `config/prod.ts`:

```typescript
export default {
  env: {
    NODE_ENV: '"production"',
    TARO_APP_API_BASE: '"https://api.feihan.cc"',
  },
};
```

本次开发和生产都指向同一后端 (hackathon 阶段不分环境)。

---

## 3. 生成页改造

### 3.1 定位现有代码

生成页大概率在这些路径之一:
- `src/pages/generating/index.tsx`
- `src/pages/generate/index.tsx`
- `src/pages/result/generating.tsx`

用 `grep -r "composer" src/pages/` 或 `grep -r "生成中" src/pages/` 定位到实际文件。

找到当前调用 composer 的地方, 大概是这样的结构 (伪代码, 具体以现状为准):

```typescript
// 当前代码 (改造前)
async function startCompose() {
  setStatus('正在生成');
  const template = getTemplateForCategory(category);
  const resultBase64 = await composer.compose({
    productImagePath: userImagePath, // 用户原图, 本地临时路径
    templateUrl: template.url,
    productName: categoryName,
  });
  setResult(resultBase64);
  setStatus('完成');
}
```

### 3.2 插入抠图步骤

改造后:

```typescript
import { segmentImage, SegmentFail } from '@/services/segment';

async function startCompose() {
  // Step 1: 抠图
  setStatus('抠出产品中');
  const segResult = await segmentImage(userImagePath);

  if (!segResult.ok) {
    handleSegmentFail(segResult);
    return;
  }

  // Step 2: 用抠图 URL 走 composer
  // 注意: 从 composer 的视角看, 产品图从"本地路径"变成了"远程 URL",
  //      Taro Canvas 加载远程图需要先 downloadFile (见 3.3)
  setStatus('合成品牌主图中');
  try {
    const template = getTemplateForCategory(category);
    const resultBase64 = await composer.compose({
      productImageUrl: segResult.imageUrl, // 变化: 传 URL 而不是本地路径
      templateUrl: template.url,
      productName: categoryName,
    });
    setResult(resultBase64);
    setStatus('完成');
  } catch (err) {
    console.error('[compose] failed:', err);
    Taro.showModal({
      title: '合成失败',
      content: '请稍后重试',
      showCancel: false,
      confirmText: '重新上传',
      success: () => Taro.navigateBack(),
    });
  }
}

function handleSegmentFail(fail: SegmentFail) {
  const msgMap: Record<SegmentFail['code'], string> = {
    SEGMENT_NO_SUBJECT: '没识别到产品, 换张清晰点的图试试',
    SEGMENT_API_FAILED: '抠图服务开小差了, 请稍后重试',
    UPLOAD_FAILED: '网络不稳定, 请重试',
    BAD_INPUT: '图片有问题, 请重新选择',
    TIMEOUT: '请求超时, 请检查网络后重试',
    NETWORK: '网络错误, 请重试',
  };
  Taro.showModal({
    title: '抠图失败',
    content: msgMap[fail.code] || fail.message,
    showCancel: false,
    confirmText: '重新上传',
    success: () => Taro.navigateBack(),
  });
}
```

### 3.3 composer 签名调整 (如果需要)

查看 composer.ts 当前的 `compose()` 函数签名。**v5b 的目标是让 composer 能接收远程 URL 作为产品图**, 最小改动是:

如果 composer 当前只支持本地路径, 在调用 composer 之前先 downloadFile 到本地:

```typescript
// 在 startCompose 的 Step 2 里:
const { tempFilePath: productLocalPath } = await Taro.downloadFile({ url: segResult.imageUrl });
const resultBase64 = await composer.compose({
  productImagePath: productLocalPath, // 保持原有签名
  templateUrl: template.url,
  productName: categoryName,
});
```

这样 composer.ts 完全不用改, 完美适配 v5b 的只改上层策略。**推荐选这个方案**。

---

## 4. 上传页可选优化 (低优先级, 时间够再做)

现状推测: 用户从相册或相机拍的图直接进入流程, 可能是 3-5MB 的原图。

如果抠图接口经常因为图片过大失败, 可以在上传页加一步压缩:

```typescript
// 上传页的 handleUpload 内部
const { tempFilePaths } = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] });
// sizeType: ['compressed'] 告诉微信返回压缩版, 通常 <1MB
```

`sizeType: ['compressed']` 是最便宜的压图方案, 加这一行参数即可, 不用自己写 canvas 压缩。

**本次 hackathon 建议直接加上**, 零成本收益大。

---

## 5. 真机测试流程

### 5.1 开发者工具测试

1. 确认 `config/dev.ts` 的 `TARO_APP_API_BASE` 指向 `https://api.feihan.cc`
2. `pnpm dev:weapp` 启动
3. 开发者工具里**关闭**"不校验合法域名" (测试真实网络环境)
4. 走完整流程: 上传 → 品类选择 → 生成
5. Console 应该能看到:
   - `[segment] request start`
   - 收到 `ok: true, imageUrl: 'https://public.feihan.cc/segment_cache/xxx.png', cached: false`
   - composer 合成完成

### 5.2 真机预览

1. 开发者工具右上角 → 预览, 用自己手机扫码
2. 重要: **真机上小程序后台的合法域名白名单必须已加**, 否则 wx.request 会报 "url not in domain list"
3. 走完整流程, 检查结果图是抠图后的透明底产品贴到模板上, 还是旧版白色卡片
4. **预期效果 v5b 阶段还不是最终态**: 合成结果会把透明 PNG 按照现有 composer 的逻辑画上去, 可能边缘仍有宣纸卡片的影子 — 这是正常的, v6 会彻底切换到 Premium 合成模式

### 5.3 故障排查

| 现象 | 排查方向 |
|---|---|
| wx.request 报 "url not in domain list" | 微信后台 request 合法域名没加 api.feihan.cc, 或加了但开发者工具缓存没刷新 (重启工具) |
| downloadFile 报同样的错 | downloadFile 合法域名没加 public.feihan.cc |
| 抠图返回 504 或 TIMEOUT | Vercel 冷启动或 10s 超时, 重试一次应该能过。如果每次都 504, 看 Vercel 控制台 Functions 日志 |
| 抠图返回 SEGMENT_NO_SUBJECT | 测试图里确实没有清晰的商品主体, 换图 |
| 抠图成功但 composer 合成崩溃 | downloadFile 拿到的是 PNG, 但 composer 可能只处理过 JPG, 看 Canvas API 报错 |
| 结果图还是白色卡片效果 | 这是正常的, v5b 只打通抠图链路, 合成视觉 v6 才改 |

---

## 6. 自测 checklist

- [ ] 微信公众平台加了 `api.feihan.cc` 到 request 白名单
- [ ] 微信公众平台加了 `public.feihan.cc` 到 downloadFile 白名单
- [ ] `src/services/segment.ts` 已创建
- [ ] 生成页改造完成, 插入抠图步骤
- [ ] 开发者工具里, "不校验合法域名"关闭状态下, 流程能跑通
- [ ] Console 能看到 `cached: false` → 再测一次同图变 `cached: true`
- [ ] 手动断网一次模拟失败, 弹窗文案正确
- [ ] 真机预览生产流程能跑通 (至少自己 3 部不同手机测过)
- [ ] 上传页已加 `sizeType: ['compressed']` 参数

---

## 7. 不要做的事

- 不要修改 composer.ts 的 Canvas 合成算法 (v6 做)
- 不要改模板 registry
- 不要在前端做 base64 解码或 PNG 处理 (小程序 JS 性能差, 全走后端)
- 不要在小程序端直接调阿里云 SDK (AK 会打包进小程序)
- 不要给 segmentImage() 加本地缓存 (后端已经有 MD5 缓存, 前端再加一层心智负担)
- 不要在失败时静默继续 (必须弹窗告诉用户, 否则用户不知道为什么结果图和预期不同)

---

## 8. v6 预告

v5b 完成后的表现: 抠图成功, 合成图里产品是抠出来的 PNG, 但仍然套在宣纸白卡片里。

v6 的工作是**切换 composer 到 Premium 模式**:

- 把抠图 PNG 直接画到模板背景上 (不套宣纸卡片)
- 加暖棕投影 `rgba(58,42,28,0.35) blur 28 offsetY 18`
- 按 `productZone={cx, cy, maxW, maxH}` 精确定位避开构图重心
- 修复「黟县香榧」文字在深色木纹上看不清的问题 (加半透明浅色底衬, 或印章落款改位置)

v5b 所有 checklist 打勾、真机演示无异常后, 再开 v6 prompt。
