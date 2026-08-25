import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, webcrypto } from 'node:crypto';
import {
  alipaySignContent, createAlipayPayment, enabledAlipayProducts, handleAlipayNotify,
  queryAlipayPayment, refundAlipayPayment,
} from '../src/alipay-plugin.js';
import {
  createWechatNativePayment, createWechatV2Payment, decodeWechatXml, encodeWechatXml, enabledWechatProducts,
  exchangeWechatOAuthCode, handleWechatV2Notify, queryWechatV2Payment, refundWechatV2Payment,
  resolveWechatV2Products, signWechatV2, wechatOAuthAuthorizeUrl, wechatV2NotifyResponse,
  wechatV2SignContent,
} from '../src/wechat-v2-plugin.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!globalThis.crypto) globalThis.crypto = webcrypto;
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('支付宝网页支付保持原 page.pay 参数、RSA2 签名与 passback_params', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    mode: 'key',
    app_id: '2026000000000000',
    private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    alipay_public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    enabled_products: ['web'],
  };
  const result = await createAlipayPayment(config, {
    payNo: 'p_contract3',
    amount: 2050,
    subject: '网页支付测试',
    body: '网页支付测试',
    merchantParam: '订单 A/B',
    returnUrl: 'https://merchant.example/return',
    providerReturnUrl: 'https://worker.example/api/pay/p_contract3/callback',
    callbackUrl: 'https://worker.example/api/pay/p_contract3/callback',
  });

  assert.equal(result.pay_product, 'web');
  assert.equal(result.pay_action, 'jump');
  const url = new URL(result.pay_params.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const biz = JSON.parse(params.biz_content);
  assert.equal(url.origin + url.pathname, 'https://openapi.alipay.com/gateway.do');
  assert.equal(params.method, 'alipay.trade.page.pay');
  assert.equal(params.sign_type, 'RSA2');
  assert.equal(params.return_url, 'https://worker.example/api/pay/p_contract3/callback');
  assert.equal(biz.out_trade_no, 'p_contract3');
  assert.equal(biz.total_amount, '20.50');
  assert.equal(biz.product_code, 'FAST_INSTANT_TRADE_PAY');
  assert.equal(biz.passback_params, '%E8%AE%A2%E5%8D%95%20A%2FB');
  assert.equal(
    nodeVerify('RSA-SHA256', Buffer.from(alipaySignContent(params)), publicKey, Buffer.from(params.sign, 'base64')),
    true,
  );
});
test('支付宝 H5 与 APP 支付生成官方签名参数且保持原产品码', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    mode: 'key',
    app_id: '2026000000000010',
    private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    alipay_public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    enabled_products: ['h5', 'app'],
  };
  const common = {
    payNo: 'p_alipay_client',
    amount: 120,
    subject: '支付宝客户端产品测试',
    returnUrl: 'https://merchant.example/return',
    providerReturnUrl: 'https://worker.example/api/pay/p_alipay_client/callback',
    callbackUrl: 'https://worker.example/api/pay/p_alipay_client/callback',
  };

  const h5 = await createAlipayPayment(config, { ...common, alipayProduct: 'h5' });
  const h5Params = Object.fromEntries(new URL(h5.pay_params.url).searchParams.entries());
  assert.equal(h5.pay_product, 'h5');
  assert.equal(h5Params.method, 'alipay.trade.wap.pay');
  assert.equal(JSON.parse(h5Params.biz_content).product_code, 'QUICK_WAP_WAY');
  assert.equal(JSON.parse(h5Params.biz_content).quit_url, common.returnUrl);
  assert.equal(h5Params.return_url, common.providerReturnUrl);
  assert.equal(
    nodeVerify('RSA-SHA256', Buffer.from(alipaySignContent(h5Params)), publicKey, Buffer.from(h5Params.sign, 'base64')),
    true,
  );

  const app = await createAlipayPayment(config, { ...common, alipayProduct: 'app' });
  const appParams = Object.fromEntries(new URLSearchParams(app.pay_params.order_string).entries());
  assert.equal(app.pay_product, 'app');
  assert.equal(appParams.method, 'alipay.trade.app.pay');
  assert.equal(JSON.parse(appParams.biz_content).product_code, 'QUICK_MSECURITY_PAY');
  assert.equal(appParams.notify_url, common.callbackUrl);
  assert.equal(
    nodeVerify('RSA-SHA256', Buffer.from(alipaySignContent(appParams)), publicKey, Buffer.from(appParams.sign, 'base64')),
    true,
  );
});
test('支付宝订单码、小程序与付款码产品调用对应 OpenAPI 并验签响应', async () => {
  const appPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alipayPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    mode: 'key',
    app_id: '2026000000000011',
    private_key: appPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    alipay_public_key: alipayPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    enabled_products: ['scan', 'mini', 'pos'],
    mini_app_id: '2026000000000099',
    mini_launch_path: 'pages/pay/index',
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const form = new URLSearchParams(options.body);
    const method = form.get('method');
    const biz = JSON.parse(form.get('biz_content'));
    calls.push({ method, biz, notifyUrl: form.get('notify_url') });
    const data = {
      'alipay.trade.precreate': {
        code: '10000',
        msg: 'Success',
        out_trade_no: biz.out_trade_no,
        qr_code: 'https://qr.alipay.example/contract',
      },
      'alipay.trade.create': {
        code: '10000',
        msg: 'Success',
        out_trade_no: biz.out_trade_no,
        trade_no: '202607280001',
      },
      'alipay.trade.pay': {
        code: '10003',
        msg: 'order success pay inprocess',
        out_trade_no: biz.out_trade_no,
        trade_no: '202607280002',
      },
    }[method];
    const responseNode = JSON.stringify(data);
    const signature = nodeSign('RSA-SHA256', Buffer.from(responseNode), alipayPair.privateKey).toString('base64');
    const key = `${method.replaceAll('.', '_')}_response`;
    return new Response(`{"${key}":${responseNode},"sign":"${signature}"}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const common = {
    payNo: 'p_alipay_server',
    amount: 101,
    subject: '支付宝服务端产品测试',
    callbackUrl: 'https://worker.example/api/pay/p_alipay_server/callback',
  };
  try {
    const scan = await createAlipayPayment(config, { ...common, alipayProduct: 'scan' });
    assert.equal(scan.pay_product, 'scan');
    assert.equal(scan.pay_params.qrcode, 'https://qr.alipay.example/contract');
    assert.equal(calls[0].method, 'alipay.trade.precreate');
    assert.equal(calls[0].biz.product_code, 'QR_CODE_OFFLINE');

    const mini = await createAlipayPayment(config, {
      ...common,
      alipayProduct: 'mini',
      buyerOpenId: 'buyer-open-contract',
    });
    assert.equal(mini.pay_product, 'mini');
    assert.equal(mini.pay_params.tradeNO, '202607280001');
    assert.equal(mini.pay_params.app_id, config.mini_app_id);
    assert.equal(mini.pay_params.mini_launch_path, config.mini_launch_path);
    assert.equal(calls[1].method, 'alipay.trade.create');
    assert.equal(calls[1].biz.product_code, 'JSAPI_PAY');
    assert.equal(calls[1].biz.op_app_id, config.mini_app_id);
    assert.equal(calls[1].biz.buyer_open_id, 'buyer-open-contract');

    const pos = await createAlipayPayment(config, {
      ...common,
      alipayProduct: 'pos',
      authCode: '28763443825664394',
    });
    assert.equal(pos.pay_product, 'pos');
    assert.equal(pos.pay_page, 'page');
    assert.equal(calls[2].method, 'alipay.trade.pay');
    assert.equal(calls[2].biz.product_code, 'FACE_TO_FACE_PAYMENT');
    assert.equal(calls[2].biz.scene, 'bar_code');
    assert.equal(calls[2].biz.auth_code, '28763443825664394');
    assert.equal(calls.every((call) => call.notifyUrl === common.callbackUrl), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('支付宝异步通知保持原参数排除规则、app_id 校验和状态映射', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    app_id: '2026000000000001',
    alipay_public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  const params = {
    app_id: config.app_id,
    notify_id: 'notify_contract_1',
    out_trade_no: 'p_contract4',
    trade_no: '2026072700001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '20.00',
    gmt_payment: '2026-07-27 12:30:00',
    sign_type: 'RSA2',
  };
  params.sign = nodeSign(
    'RSA-SHA256',
    Buffer.from(alipaySignContent(params, true)),
    privateKey,
  ).toString('base64');

  const request = new Request('https://worker.example/api/pay/p_contract4/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const result = await handleAlipayNotify(request, config);
  assert.equal(result.status, 'success');
  assert.equal(result.payNo, 'p_contract4');
  assert.equal(result.channelTradeNo, '2026072700001');
  assert.equal(result.eventId, 'notify_contract_1');
});
test('微信 V2 Native 下单保持原 unifiedorder XML 与 HMAC-SHA256 签名', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      return_msg: 'OK',
      result_code: 'SUCCESS',
      code_url: 'weixin://wxpay/bizpayurl?pr=contract',
    }), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    });
  };
  try {
    const config = {
      api_version: 'v2',
      mode: 'merchant',
      mch_id: '1900000001',
      app_id: 'wx_contract',
      api_v2_key: 'contract-v2-api-key',
      enabled_products: ['scan'],
    };
    const result = await createWechatNativePayment(config, {
      payNo: 'p_contract5',
      amount: 2300,
      subject: '微信 Native 测试',
      callbackUrl: 'https://worker.example/api/pay/p_contract5/callback',
      clientIp: '203.0.113.8',
    });
    assert.equal(result.pay_page, 'qrcode');
    assert.equal(result.pay_product, 'scan');
    assert.equal(result.pay_params.qrcode, 'weixin://wxpay/bizpayurl?pr=contract');
    assert.equal(captured.url, 'https://api.mch.weixin.qq.com/pay/unifiedorder');
    const requestXml = decodeWechatXml(captured.options.body);
    assert.equal(requestXml.trade_type, 'NATIVE');
    assert.equal(requestXml.product_id, 'p_contract5');
    assert.equal(requestXml.out_trade_no, 'p_contract5');
    assert.equal(requestXml.total_fee, '2300');
    assert.equal(requestXml.spbill_create_ip, '203.0.113.8');
    assert.equal(
      requestXml.sign,
      await signWechatV2(requestXml, config.api_v2_key, 'HMAC-SHA256'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('微信 V2 JSAPI 下单使用公众号 AppID、openid 与官方二次签名字段', async () => {
  let requestXml;
  const config = {
    api_version: 'v2',
    mode: 'merchant',
    mch_id: '1900000001',
    app_id: 'wx_default',
    mp_app_id: 'wx_mp_contract',
    api_v2_key: 'contract-v2-api-key',
    enabled_products: ['mp'],
  };
  const result = await createWechatV2Payment(config, {
    payNo: 'p_jsapi_contract',
    amount: 101,
    subject: '微信 JSAPI 测试',
    callbackUrl: 'https://worker.example/api/pay/p_jsapi_contract/callback',
    paymentUrl: 'https://worker.example/payment/p_jsapi_contract',
    clientIp: '203.0.113.9',
    device: 'wechat',
    openid: 'o-contract-openid',
  }, async (_url, options) => {
    requestXml = decodeWechatXml(options.body);
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      prepay_id: 'wx_prepay_jsapi',
    }));
  });

  assert.equal(requestXml.appid, 'wx_mp_contract');
  assert.equal(requestXml.trade_type, 'JSAPI');
  assert.equal(requestXml.openid, 'o-contract-openid');
  assert.equal(result.pay_page, 'jsapi');
  assert.equal(result.pay_product, 'mp');
  const {
    appId, timeStamp, nonceStr, package: packageValue, signType, paySign,
  } = result.pay_params;
  assert.equal(packageValue, 'prepay_id=wx_prepay_jsapi');
  assert.equal(
    paySign,
    await signWechatV2({
      appId, timeStamp, nonceStr, package: packageValue, signType,
    }, config.api_v2_key, signType),
  );
});
test('微信 V2 H5 下单使用 MWEB 和官方 WAP scene_info', async () => {
  let requestXml;
  const config = {
    api_version: 'v2',
    mode: 'merchant',
    mch_id: '1900000001',
    app_id: 'wx_default',
    api_v2_key: 'contract-v2-api-key',
    enabled_products: ['h5'],
    h5_info_type: 'Wap',
    h5_app_name: 'EdgePay 测试',
    h5_app_url: 'https://pay.example',
  };
  const result = await createWechatV2Payment(config, {
    payNo: 'p_h5_contract',
    amount: 102,
    subject: '微信 H5 测试',
    callbackUrl: 'https://worker.example/api/pay/p_h5_contract/callback',
    paymentUrl: 'https://worker.example/payment/p_h5_contract',
    clientIp: '203.0.113.10',
    device: 'mobile',
  }, async (_url, options) => {
    requestXml = decodeWechatXml(options.body);
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      mweb_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=h5',
    }));
  });

  assert.equal(requestXml.trade_type, 'MWEB');
  assert.deepEqual(JSON.parse(requestXml.scene_info), {
    h5_info: {
      type: 'Wap',
      wap_url: 'https://pay.example',
      wap_name: 'EdgePay 测试',
    },
  });
  assert.equal(result.pay_page, 'jump');
  assert.equal(
    new URL(result.pay_params.url).searchParams.get('redirect_url'),
    'https://worker.example/payment/p_h5_contract',
  );
});
test('微信 V2 APP 下单返回可交给原生 SDK 的签名参数', async () => {
  let requestXml;
  const config = {
    api_version: 'v2',
    mode: 'merchant',
    mch_id: '1900000001',
    app_id: 'wx_default',
    app_app_id: 'wx_app_contract',
    api_v2_key: 'contract-v2-api-key',
    enabled_products: ['app'],
  };
  const result = await createWechatV2Payment(config, {
    payNo: 'p_app_contract',
    amount: 103,
    subject: '微信 APP 测试',
    callbackUrl: 'https://worker.example/api/pay/p_app_contract/callback',
    clientIp: '203.0.113.11',
    device: 'app',
  }, async (_url, options) => {
    requestXml = decodeWechatXml(options.body);
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      prepay_id: 'wx_prepay_app',
    }));
  });

  assert.equal(requestXml.appid, 'wx_app_contract');
  assert.equal(requestXml.trade_type, 'APP');
  assert.equal(result.pay_product, 'app');
  const params = result.pay_params.params;
  assert.equal(params.prepayId, 'wx_prepay_app');
  assert.equal(
    params.sign,
    await signWechatV2({
      appid: params.appId,
      partnerid: params.partnerId,
      prepayid: params.prepayId,
      package: params.packageValue,
      noncestr: params.nonceStr,
      timestamp: params.timeStamp,
    }, config.api_v2_key, 'HMAC-SHA256'),
  );
});
test('微信 V2 小程序下单使用小程序 AppID 并返回 wx.requestPayment 参数', async () => {
  let requestXml;
  const config = {
    api_version: 'v2',
    mode: 'merchant',
    mch_id: '1900000001',
    app_id: 'wx_default',
    mini_app_id: 'wx_mini_contract',
    api_v2_key: 'contract-v2-api-key',
    enabled_products: ['mini'],
  };
  const result = await createWechatV2Payment(config, {
    payNo: 'p_mini_contract',
    amount: 104,
    subject: '微信小程序测试',
    callbackUrl: 'https://worker.example/api/pay/p_mini_contract/callback',
    clientIp: '203.0.113.12',
    device: 'wechat',
    miniOpenid: 'mini-contract-openid',
  }, async (_url, options) => {
    requestXml = decodeWechatXml(options.body);
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      prepay_id: 'wx_prepay_mini',
    }));
  });

  assert.equal(requestXml.appid, 'wx_mini_contract');
  assert.equal(requestXml.trade_type, 'JSAPI');
  assert.equal(requestXml.openid, 'mini-contract-openid');
  assert.equal(result.pay_product, 'mini');
  assert.equal(result.pay_params.app_id, 'wx_mini_contract');
  const params = result.pay_params.request_payment;
  assert.equal(
    params.paySign,
    await signWechatV2({
      appId: 'wx_mini_contract',
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType,
    }, config.api_v2_key, params.signType),
  );
});
test('微信 JSAPI 缺少 openid 时生成官方 OAuth 地址并可交换 openid', async () => {
  const config = {
    api_version: 'v2',
    mode: 'merchant',
    mch_id: '1900000001',
    app_id: 'wx_default',
    mp_app_id: 'wx_mp_contract',
    mp_app_secret: 'mp-contract-secret',
    api_v2_key: 'contract-v2-api-key',
    enabled_products: ['mp'],
  };
  const result = await createWechatV2Payment(config, {
    payNo: 'p_oauth_contract',
    amount: 105,
    subject: '微信 OAuth 测试',
    callbackUrl: 'https://worker.example/api/pay/p_oauth_contract/callback',
    oauthCallbackUrl: 'https://worker.example/api/wechat/oauth/callback?resume=signed',
    device: 'wechat',
  }, async () => {
    throw new Error('OAuth 前不应调用统一下单');
  });
  const authorizeUrl = new URL(result.pay_params.url);
  assert.equal(authorizeUrl.origin, 'https://open.weixin.qq.com');
  assert.equal(authorizeUrl.searchParams.get('appid'), 'wx_mp_contract');
  assert.equal(
    authorizeUrl.searchParams.get('redirect_uri'),
    'https://worker.example/api/wechat/oauth/callback?resume=signed',
  );

  const identity = await exchangeWechatOAuthCode(config, 'oauth-code', async (url) => {
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    return new Response(JSON.stringify({ openid: 'oauth-openid', unionid: 'oauth-unionid' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(identity.openid, 'oauth-openid');
});
test('微信 V2 通知保持原 XML 验签、订单号提取与 SUCCESS 应答语义', async () => {
  const config = {
    api_v2_key: 'contract-v2-api-key',
    mch_id: '1900000001',
    app_id: 'wx_contract',
  };
  const data = {
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    appid: 'wx_contract',
    mch_id: '1900000001',
    out_trade_no: 'p_contract6',
    transaction_id: '4200000000202607270001',
    total_fee: '2300',
    time_end: '20260727153045',
    nonce_str: 'contractnonce',
    sign_type: 'HMAC-SHA256',
  };
  data.sign = await signWechatV2(data, config.api_v2_key, data.sign_type);
  const request = new Request('https://worker.example/api/pay/p_contract6/callback', {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: encodeWechatXml(data),
  });
  const result = await handleWechatV2Notify(request, config);
  assert.equal(result.status, 'success');
  assert.equal(result.payNo, 'p_contract6');
  assert.equal(result.channelTradeNo, '4200000000202607270001');
  assert.equal(result.paidAt, '2026-07-27 15:30:45');
  assert.equal(result.amountFen, 2300);
  assert.equal(JSON.parse(result.raw).request.appid, 'wx_contract');
  assert.equal(JSON.parse(result.raw).request.mch_id, '1900000001');
});
test('微信 V2 HMAC 通知缺少 sign_type 时按签名长度兼容验签', async () => {
  const config = {
    api_v2_key: 'contract-v2-api-key',
    mch_id: '1900000001',
    app_id: 'wx_contract',
  };
  const data = {
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    appid: 'wx_contract',
    mch_id: '1900000001',
    out_trade_no: 'p_contract7',
    transaction_id: '4200000000202607270002',
    total_fee: '1',
    time_end: '20260727153100',
    nonce_str: 'contractnonce2',
  };
  data.sign = await signWechatV2(data, config.api_v2_key, 'HMAC-SHA256');
  const result = await handleWechatV2Notify(new Request(
    'https://worker.example/api/pay/p_contract7/callback',
    {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: encodeWechatXml(data),
    },
  ), config);
  assert.equal(result.status, 'success');
  assert.equal(result.amountFen, 1);
  assert.equal(result.channelTradeNo, '4200000000202607270002');
});
test('微信 V2 失败应答保持 MPay 的 HTTP 200 XML 语义', async () => {
  const response = wechatV2NotifyResponse(false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.equal(decodeWechatXml(await response.text()).return_code, 'FAIL');
});
test('支付宝 API 退款保持 trade.refund 请求、RSA2 响应验签和 out_request_no', async () => {
  const appPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alipayPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const originalFetch = globalThis.fetch;
  let requestBiz;
  globalThis.fetch = async (_url, options) => {
    const form = new URLSearchParams(options.body);
    requestBiz = JSON.parse(form.get('biz_content'));
    const responseNode = JSON.stringify({
      code: '10000',
      msg: 'Success',
      trade_no: 'ALIPAY_TRADE_1',
      fund_change: 'Y',
    });
    const signature = nodeSign('RSA-SHA256', Buffer.from(responseNode), alipayPair.privateKey).toString('base64');
    return new Response(`{"alipay_trade_refund_response":${responseNode},"sign":"${signature}"}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await refundAlipayPayment({
      mode: 'key',
      app_id: '2026000000000002',
      private_key: appPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      alipay_public_key: alipayPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }, {
      payNo: 'p_refund_alipay',
      providerTradeNo: 'ALIPAY_TRADE_1',
      refundNo: 'RFD_ALIPAY_1',
      refundAmount: 990,
      reason: '用户申请',
    });
    assert.equal(result.success, true);
    assert.equal(requestBiz.trade_no, 'ALIPAY_TRADE_1');
    assert.equal(requestBiz.refund_amount, '9.90');
    assert.equal(requestBiz.out_request_no, 'RFD_ALIPAY_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('微信 V2 API 退款只通过 mTLS transport 调用 secapi 并保持原 XML 签名', async () => {
  let captured;
  const mtlsFetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(encodeWechatXml({
      return_code: 'SUCCESS',
      return_msg: 'OK',
      result_code: 'SUCCESS',
      refund_id: 'WX_REFUND_1',
    }), { status: 200, headers: { 'content-type': 'text/xml' } });
  };
  const config = {
    api_version: 'v2',
    mch_id: '1900000001',
    app_id: 'wx_contract',
    api_v2_key: 'contract-v2-api-key',
  };
  const result = await refundWechatV2Payment(config, {
    payNo: 'p_refund_wechat',
    refundNo: 'RFD_WECHAT_1',
    amount: 2_300,
    refundAmount: 600,
    reason: '用户申请',
  }, mtlsFetch);
  assert.equal(result.success, true);
  assert.equal(captured.url, 'https://api.mch.weixin.qq.com/secapi/pay/refund');
  const requestXml = decodeWechatXml(captured.options.body);
  assert.equal(requestXml.total_fee, '2300');
  assert.equal(requestXml.refund_fee, '600');
  assert.equal(requestXml.out_refund_no, 'RFD_WECHAT_1');
  assert.equal(
    requestXml.sign,
    await signWechatV2(requestXml, config.api_v2_key, 'HMAC-SHA256'),
  );
});
