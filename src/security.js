export function safeWebhookUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const privateIpv4 = /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./u.test(host);
    const privateIpv6 = host === '::1' || host === '[::1]'
      || /^\[?(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*\]?$/u.test(host);
    const localName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
    return url.protocol === 'https:' && !url.username && !url.password && !localName && !privateIpv4 && !privateIpv6;
  } catch {
    return false;
  }
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
