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
 * Call Alibaba SegmentCommodity; returns a temporary PNG URL (download and re-upload promptly).
 * The published @alicloud/viapi20230117 client has no segmentCommodity; this uses openapi-client POP RPC (same action/version/params as imageseg SDK).
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
    console.error('[segment] viapi call failed:', err);
    throw new SegmentError('SEGMENT_API_FAILED', err?.message || 'viapi 调用失败');
  }
}
