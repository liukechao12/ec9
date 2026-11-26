-- EC9 微信内 JSAPI 支付：公众号 AppSecret 密文列（2026-11-26）
-- 幂等，可重复执行；不影响下单，Native 扫码不依赖此列。
-- 用途：公众号 AppSecret（AES-256-CBC 加密），snsapi_base 网页授权换 openid。
ALTER TABLE ec9_payment_configs
  ADD COLUMN IF NOT EXISTS app_secret_enc TEXT;
