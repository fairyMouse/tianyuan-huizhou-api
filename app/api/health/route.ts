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
