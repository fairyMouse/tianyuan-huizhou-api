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

