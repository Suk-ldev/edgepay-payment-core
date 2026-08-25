import assert from 'node:assert/strict';
import test from 'node:test';
import { publicEndpointUrl } from '../src/index.js';

test('官方渠道回调始终使用 PUBLIC_BASE_URL', () => {
  const request = new Request('https://temporary.workers.dev/admin/channels');
  assert.equal(
    publicEndpointUrl(request, { PUBLIC_BASE_URL: 'https://pay.example.com' }, '/api/pay/p_1/callback'),
    'https://pay.example.com/api/pay/p_1/callback',
  );
});

test('未配置公开地址时回退到当前请求来源', () => {
  const request = new Request('https://temporary.workers.dev/mapi.php');
  assert.equal(
    publicEndpointUrl(request, {}, '/api/pay/p_1/callback'),
    'https://temporary.workers.dev/api/pay/p_1/callback',
  );
});
