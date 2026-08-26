import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOrderTimeline, callbackSummary, confirmationSource,
  normalizeAdminOrderQuery, resolveOrderActions,
} from '../src/order-actions.js';
import { RUNTIME_KEY, createPluginRegistry, freePlugins } from '../src/index.js';
import { fakeDirectPlugin } from './helpers/fake-plugins.mjs';

// 接口退款能力现在由插件自己声明，核心从 env 上的运行时里问。
// Stripe 已归私有仓库，这里用同编码的假插件代替：它实现了 refundPayment。
const registry = createPluginRegistry([
  ...freePlugins,
  fakeDirectPlugin('stripe_api', { name: 'Stripe支付API' }),
]);
const runtimeEnv = (env = {}) => ({ ...env, [RUNTIME_KEY]: { registry } });

// 收款监听类插件的回调文案与渠道回调不同，调用方要把这个判断传进来。
const isReceiptPlugin = (code) => registry.get(code)?.manifest.mode === 'channel-notify';
const summarize = (row, code) => callbackSummary(row, code, isReceiptPlugin(code));

function enabled(order, env = {}) {
  return resolveOrderActions(order, runtimeEnv(env))
    .filter((action) => action.enabled)
    .map((action) => action.code);
}

test('未成功订单保持原项目的主动查询、手动补单和冻结动作', () => {
  const actions = enabled({
    status: 'PAYING',
    plugin_code: 'fubei_receipt',
    notify_url: 'https://merchant.example/notify',
    is_frozen: 0,
    refundable_amount_fen: 0,
  });
  assert.deepEqual(actions, ['manual_success', 'active_query', 'freeze']);
});

test('成功官方订单开放重新通知、API退款、手动退款和冻结', () => {
  const actions = enabled({
    status: 'PAID',
    plugin_code: 'stripe_api',
    notify_url: 'https://merchant.example/notify',
    is_frozen: 0,
    refundable_amount_fen: 1_500,
  });
  assert.deepEqual(actions, ['renotify', 'api_refund', 'manual_refund', 'freeze']);
});

test('个人、付呗和 USDT 收款不伪造 API 退款能力', () => {
  for (const pluginCode of ['wxpay_receipt', 'fubei_receipt', 'usdt_trc20_receipt']) {
    const actions = enabled({
      status: 'PAID',
      plugin_code: pluginCode,
      notify_url: '',
      is_frozen: 0,
      refundable_amount_fen: 600,
    });
    assert.deepEqual(actions, ['manual_refund', 'freeze']);
  }
});

test('支付宝未配置退款证书时不开放 API 退款', () => {
  const actions = enabled({
    status: 'PAID',
    plugin_code: 'alipay_api',
    notify_url: 'https://merchant.example/notify',
    is_frozen: 0,
    refundable_amount_fen: 600,
  });
  assert.deepEqual(actions, ['renotify', 'manual_refund', 'freeze']);
});

test('微信 V2 只有绑定出站 mTLS 证书后才开放 API 退款', () => {
  const order = {
    status: 'PAID',
    plugin_code: 'wechat_api',
    notify_url: '',
    is_frozen: 0,
    refundable_amount_fen: 2_000,
  };
  assert.deepEqual(enabled(order), ['manual_refund', 'freeze']);
  assert.deepEqual(enabled(order, { WECHAT_MTLS: { fetch() {} } }), ['api_refund', 'manual_refund', 'freeze']);
});

test('冻结订单只保留解冻动作', () => {
  const actions = enabled({
    status: 'PAID',
    plugin_code: 'paypal_api',
    notify_url: 'https://merchant.example/notify',
    is_frozen: 1,
    refundable_amount_fen: 2_000,
  });
  assert.deepEqual(actions, ['unfreeze']);
});

test('订单确认来源可区分 Worker、NAS、SmsForwarder 与手动补单', () => {
  assert.deepEqual(
    confirmationSource({
      receipt_event_source: 'fubei_receipt',
      receipt_event_id: 'FB-1',
      receipt_event_raw_json: JSON.stringify({ source: 'worker_poller' }),
    }),
    {
      code: 'worker_poller',
      label: 'Worker 内置轮询',
      event_id: 'FB-1',
      state: '',
      received_at: '',
      processed_at: '',
    },
  );
  assert.equal(confirmationSource({
    receipt_event_source: 'usdt_trc20_receipt',
    receipt_event_raw_json: JSON.stringify({ delivery_source: 'nas_watcher' }),
  }).label, 'NAS Watcher');
  assert.equal(confirmationSource({
    receipt_event_source: 'wxpay_receipt',
    receipt_event_raw_json: '{}',
  }).label, 'SmsForwarder');
  assert.equal(confirmationSource({
    metadata_json: JSON.stringify({ payment_confirmation: { source: 'manual' } }),
  }).label, '后台手动补单');
});

test('订单列表查询只接受既定筛选项并规范分页', () => {
  assert.deepEqual(
    normalizeAdminOrderQuery({
      page: '3',
      page_size: '50',
      search_field: 'payment_no',
      keyword: '  p_123  ',
      plugin_code: 'stripe_api',
      status: 'PAID',
      callback_status: 'SUCCESS',
    }, new Set(registry.codes())),
    {
      page: 3,
      page_size: 50,
      search_field: 'payment_no',
      keyword: 'p_123',
      plugin_code: 'stripe_api',
      status: 'PAID',
      callback_status: 'SUCCESS',
    },
  );
  assert.deepEqual(
    normalizeAdminOrderQuery({
      page: '-2',
      page_size: '17',
      search_field: 'sql',
      plugin_code: 'unknown',
      status: 'DROP TABLE',
      callback_status: 'unknown',
    }, new Set(registry.codes())),
    {
      page: 1,
      page_size: 20,
      search_field: 'all',
      keyword: '',
      plugin_code: '',
      status: '',
      callback_status: '',
    },
  );
});

test('回调统计区分官方回调与收款监听并保留次数', () => {
  assert.deepEqual(
    summarize({
      callback_times: 2,
      callback_processed_times: 2,
      callback_rejected_times: 0,
      callback_pending_times: 0,
    }, 'stripe_api'),
    {
      status: 'SUCCESS',
      status_text: '成功',
      times: 2,
      processed_times: 2,
      rejected_times: 0,
      pending_times: 0,
      kind: 'callback',
    },
  );
  assert.equal(summarize({
    callback_times: 1,
    callback_processed_times: 1,
  }, 'fubei_receipt').status_text, '监听成功');
  assert.equal(summarize({
    callback_times: 1,
    callback_rejected_times: 1,
  }, 'wechat_api').status, 'FAILED');
  assert.equal(summarize({
    callback_times: 3,
    callback_processed_times: 1,
    callback_rejected_times: 2,
    receipt_event_state: 'PROCESSED',
  }, 'wechat_api').status, 'SUCCESS');
});

test('成功过一次就是成功，后来的未匹配事件不会把已支付订单说成处理中', () => {
  // 线上现象：一笔 SmsForwarder 订单已经"成功"，监听栏却显示"监听处理中"。
  // 原因是这一栏先看最新一条事件——确认订单那条是 PROCESSED，之后又来了一条
  // 没匹配上的 RECEIVED，最新状态就成了处理中。
  const paidWithLateNoise = {
    status: 'PAID',
    callback_times: 2,
    callback_processed_times: 1,
    callback_pending_times: 1,
    receipt_event_state: 'RECEIVED',
  };
  assert.equal(summarize(paidWithLateNoise, 'fubei_receipt').status_text, '监听成功');
  assert.equal(summarize(paidWithLateNoise, 'wechat_api').status_text, '成功');
  // 次数照旧全部保留，成功之外的那条事件不会从统计里消失。
  assert.equal(summarize(paidWithLateNoise, 'fubei_receipt').pending_times, 1);

  // 还没终态的订单只有未处理事件时，仍然是处理中。
  assert.equal(summarize({
    status: 'PAYING', callback_times: 1, callback_pending_times: 1,
  }, 'fubei_receipt').status_text, '监听处理中');

  // 订单已经终态还挂着没处理的事件，说明始终没匹配上，不该继续显示处理中。
  assert.equal(summarize({
    status: 'EXPIRED', callback_times: 1, callback_pending_times: 1,
  }, 'fubei_receipt').status_text, '监听失败');
});

test('订单时间线汇总现有监听、通知、退款和操作记录并按时间倒序', () => {
  const timeline = buildOrderTimeline({
    order: {
      payment_no: 'p_1',
      status: 'PAID',
      status_text: '成功',
      created_at: '2026-07-28T00:00:00.000Z',
      paid_at: '2026-07-28T00:01:00.000Z',
      provider_trade_no: 'trade_1',
    },
    receipt_events: [{
      kind: 'listener',
      source: { label: 'Worker 内置轮询' },
      state: 'PROCESSED',
      state_text: '成功',
      event_id: 'event_1',
      received_at: '2026-07-28T00:00:50.000Z',
    }],
    notification_tasks: [{
      id: 1,
      status: 'SENT',
      status_text: '已送达',
      attempts: 1,
      sent_at: '2026-07-28T00:02:00.000Z',
    }],
    refunds: [{
      refund_no: 'refund_1',
      method: 'MANUAL',
      status: 'SUCCEEDED',
      reason: '测试',
      updated_at: '2026-07-28T00:03:00.000Z',
    }],
    operations: [{
      action: 'manual_refund',
      result_status: 'success',
      result_message: '已登记退款',
      created_at: '2026-07-28T00:03:01.000Z',
    }],
  });
  assert.deepEqual(timeline.map((event) => event.type), [
    'operation', 'refund', 'notification', 'order', 'listener', 'order',
  ]);
  assert.equal(timeline[0].title, '手动退款');
  assert.equal(timeline.at(-1).title, '订单已创建');
});
