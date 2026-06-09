import 'dotenv/config';
import { PayOS } from '@payos/node';

async function main() {
  const clientId = requireEnv('PAYOS_CLIENT_ID');
  const apiKey = requireEnv('PAYOS_API_KEY');
  const checksumKey = requireEnv('PAYOS_CHECKSUM_KEY');
  const webhookUrl = requireEnv('PAYOS_WEBHOOK_URL');

  const payos = new PayOS({
    clientId,
    apiKey,
    checksumKey,
    partnerCode: process.env.PAYOS_PARTNER_CODE || undefined,
  });

  const result = await payos.webhooks.confirm(webhookUrl);
  console.log(
    JSON.stringify(
      {
        ok: true,
        webhookUrl: result.webhookUrl,
        paymentChannel: result.name,
        accountName: result.accountName,
        accountNumber: result.accountNumber,
      },
      null,
      2,
    ),
  );
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
