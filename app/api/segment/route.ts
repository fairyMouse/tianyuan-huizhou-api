import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  cosObjectExists,
  cosPutBuffer,
  cosPublicUrl,
} from '@/lib/cos';
import { ossPutTempJpegPublicUrl } from '@/lib/oss-temp';
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

    // 3. 原图上传到上海 OSS（SegmentCommodity 的 ImageURL 仅接受上海 OSS 标准域名，不支持 COS/CDN）
    const uploadKey = `uploads_temp/${md5}.jpg`;
    let ossImageUrl: string;
    try {
      ossImageUrl = await ossPutTempJpegPublicUrl(uploadKey, buffer);
    } catch (err) {
      console.error('[segment] OSS temp upload failed:', err);
      return NextResponse.json<SegmentErrorResp>(
        { ok: false, code: 'UPLOAD_FAILED', message: '原图上传失败' },
        { status: 500 },
      );
    }

    // 4. 调用阿里云 SegmentCommodity
    let aliResultUrl: string;
    try {
      aliResultUrl = await segmentCommodity(ossImageUrl);
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
