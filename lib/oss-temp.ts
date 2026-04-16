import OSS from 'ali-oss';

const OSS_REGION = 'oss-cn-shanghai';

function ossStandardPublicUrl(bucket: string, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}.oss-cn-shanghai.aliyuncs.com/${path}`;
}

/**
 * Upload JPEG to Shanghai OSS with public-read ACL so imageseg can fetch ImageURL.
 * Returns standard OSS URL (required by SegmentCommodity).
 */
export async function ossPutTempJpegPublicUrl(key: string, buffer: Buffer): Promise<string> {
  const bucket = process.env.ALIYUN_OSS_BUCKET!;
  if (!bucket) {
    throw new Error('ALIYUN_OSS_BUCKET is not set');
  }
  const client = new OSS({
    region: OSS_REGION,
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID!,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET!,
    bucket,
  });
  await client.put(key, buffer, {
    headers: {
      'Content-Type': 'image/jpeg',
      'x-oss-object-acl': 'public-read',
    },
  });
  return ossStandardPublicUrl(bucket, key);
}
